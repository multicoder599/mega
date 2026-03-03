require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios'); // Added for API requests

const app = express();

// 1. IMPROVED CORS: Allow your specific Surge URL + Localhost for testing
const allowedOrigins = [
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    /https:\/\/.*\.surge\.sh$/ // Securely allows any surge.sh subdomain
];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin || allowedOrigins.some(domain => 
            typeof domain === 'string' ? domain === origin : domain.test(origin)
        )) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// MONGODB CONNECTION
// ==========================================
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB successfully!'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// --- MODELS (User & Bet) ---
const userSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // Note: In production, hash this using bcrypt!
    name: { type: String, required: true },
    balance: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const betSchema = new mongoose.Schema({
    ticketId: { type: String, required: true, unique: true },
    userPhone: { type: String, required: true },
    stake: { type: Number, required: true },
    potentialWin: { type: Number, required: true },
    selections: { type: Array, required: true },
    status: { type: String, enum: ['Open', 'Won', 'Lost', 'Cashed Out'], default: 'Open' },
    createdAt: { type: Date, default: Date.now }
});
const Bet = mongoose.model('Bet', betSchema);

// ==========================================
// SECURE ODDS API ENDPOINT
// ==========================================
app.get('/api/matches', async (req, res) => {
    try {
        // Fetching broad upcoming matches across multiple sports
        const response = await axios.get('https://api.the-odds-api.com/v4/sports/upcoming/odds', {
            params: {
                apiKey: process.env.ODDS_API_KEY,
                regions: 'eu,uk',
                markets: 'h2h',
                oddsFormat: 'decimal'
            }
        });
        res.json(response.data);
    } catch (error) {
        // Better error logging for debugging API limits
        console.error('Odds API Error:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to fetch matches from external provider' });
    }
});

// ==========================================
// AUTH & BETTING ENDPOINTS
// ==========================================

// Login Endpoint
app.post('/api/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        const user = await User.findOne({ phone, password });
        if (user) {
            res.json({ success: true, user: { name: user.name, balance: user.balance, phone: user.phone } });
        } else {
            res.status(401).json({ success: false, message: 'Invalid phone number or password' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Register Endpoint
app.post('/api/register', async (req, res) => {
    try {
        const { phone, password, name } = req.body;
        
        // Check if user already exists
        const existingUser = await User.findOne({ phone });
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'Phone number already registered. Please login.' });
        }

        // Create new user (Giving them 50 KES free bonus to test with!)
        const newUser = new User({
            phone,
            password,
            name: name || 'New Player',
            balance: 50 
        });

        await newUser.save();

        res.json({ 
            success: true, 
            user: { name: newUser.name, balance: newUser.balance, phone: newUser.phone } 
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Server error during registration' });
    }
});

// Place Bet Endpoint
app.post('/api/place-bet', async (req, res) => {
    try {
        const { userPhone, stake, selections, potentialWin } = req.body;
        const user = await User.findOne({ phone: userPhone });

        if (!user || user.balance < stake) {
            return res.status(400).json({ success: false, message: 'Insufficient funds! Please deposit.' });
        }

        user.balance -= stake;
        await user.save();

        const ticketId = 'TXN-' + Math.floor(Math.random() * 900000 + 100000);
        const newBet = new Bet({ ticketId, userPhone, stake, potentialWin, selections });
        await newBet.save();

        res.json({ success: true, newBalance: user.balance, ticketId: newBet.ticketId });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Bet placement failed' });
    }
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 10000; // Render uses 10000
app.listen(PORT, () => {
    console.log(`🚀 Server live on port ${PORT}`);
});