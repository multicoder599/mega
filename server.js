require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// MONGODB CONNECTION & MODELS
// ==========================================
// Connect to local MongoDB (or replace with your MongoDB Atlas URI)
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/apexbet';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB successfully!'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// Define User Schema
const userSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // Note: In production, hash this using bcrypt!
    name: { type: String, required: true },
    balance: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// Define Bet Schema
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

// Seed a test user if the database is empty
async function seedTestUser() {
    const userExists = await User.findOne({ phone: '0712345678' });
    if (!userExists) {
        await User.create({
            phone: '0712345678',
            password: 'password123',
            name: 'John K.',
            balance: 14250
        });
        console.log('🌱 Test user created: Phone: 0712345678 | Password: password123');
    }
}
seedTestUser();

// ==========================================
// API ENDPOINTS
// ==========================================

// 2. Login Endpoint
app.post('/api/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        
        // Find user in MongoDB
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

// 3. Place Bet Endpoint
app.post('/api/place-bet', async (req, res) => {
    try {
        const { userPhone, stake, selections, potentialWin } = req.body;

        // Find user
        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        // Check balance
        if (user.balance < stake) {
            return res.status(400).json({ success: false, message: 'Insufficient funds! Please deposit.' });
        }

        // Deduct balance and save user
        user.balance -= stake;
        await user.save();

        // Create and save the Bet ticket to MongoDB
        const ticketId = 'TXN-' + Math.floor(Math.random() * 900000 + 100000);
        const newBet = new Bet({
            ticketId,
            userPhone,
            stake,
            potentialWin,
            selections
        });
        await newBet.save();

        res.json({ success: true, newBalance: user.balance, ticketId: newBet.ticketId });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Server error while placing bet' });
    }
});

// 4. Get User Balance Endpoint (To refresh UI)
app.get('/api/user/:phone', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.params.phone });
        if (user) {
            res.json({ success: true, balance: user.balance, name: user.name });
        } else {
            res.status(404).json({ success: false, message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 ApexBet Backend running at http://localhost:${PORT}`);
});