require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios');
const bcrypt = require('bcryptjs'); 
const http = require('http');

const app = express();
const server = http.createServer(app); 

// ==========================================
// CORS CONFIGURATION
// ==========================================
app.use(cors({
    origin: "*", 
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: false 
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// ENVIRONMENT VARIABLES
// ==========================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MONGO_URI = process.env.MONGO_URI;
const ODDS_API_KEY = process.env.ODDS_API_KEY; 

// ==========================================
// TELEGRAM BOT UTILITY
// ==========================================
function sendTelegramMessage(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log("⚠️ Telegram credentials missing. Message not sent.");
        return;
    }
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    // Fire and forget, no await needed so it doesn't block the main thread
    axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
        .catch(err => console.error("Telegram Notification Error:", err.message));
}

// ==========================================
// MONGODB CONNECTION & MODELS
// ==========================================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ Successfully connected to MongoDB Cluster"))
  .catch(err => {
    console.error("❌ CLUSTER CONNECTION ERROR:", err.message);
    // This stops the buffering timeout by explaining the real problem
  });
const userSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true }, 
    name: { type: String, required: true },
    balance: { type: Number, default: 0 },
    bonusBalance: { type: Number, default: 0 },
    referredBy: { type: String, default: null }, 
    notifications: { type: Array, default: [] },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const betSchema = new mongoose.Schema({
    ticketId: { type: String, required: true, unique: true },
    userPhone: { type: String, required: true },
    stake: { type: Number, required: true },
    potentialWin: { type: Number, default: 0 }, 
    selections: { type: Array, default: [] }, 
    type: { type: String, default: 'Sports' }, 
    status: { type: String, default: 'Open' }, 
    createdAt: { type: Date, default: Date.now }
});
const Bet = mongoose.model('Bet', betSchema);

const transactionSchema = new mongoose.Schema({
    refId: { type: String, required: true, unique: true }, 
    userPhone: { type: String, required: true },
    type: { type: String, required: true }, 
    method: { type: String, required: true },
    amount: { type: Number, required: true }, 
    status: { type: String, default: 'Success' }, 
    createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

const liveGameSchema = new mongoose.Schema({
    id: String, 
    category: String, 
    home: String, 
    away: String,
    odds: String, 
    draw: String, 
    away_odds: String, 
    startTime: Date, 
    time: String, 
    date: String,
    hs: { type: Number, default: 0 },
    as: { type: Number, default: 0 },
    status: { type: String, default: 'upcoming' } 
}, { strict: false }); 
const LiveGame = mongoose.model('LiveGame', liveGameSchema);

const virtualResultSchema = new mongoose.Schema({
    season: Number, 
    matchday: Number, 
    home: String, 
    away: String, 
    hs: Number, 
    as: Number, 
    odds: Object,
    createdAt: { type: Date, default: Date.now }
});
const VirtualResult = mongoose.model('VirtualResult', virtualResultSchema);

const virtualStateSchema = new mongoose.Schema({
    stateId: { type: String, default: 'MAIN_STATE' },
    currentSeason: { type: Number, default: 1 },
    standingsData: { type: Array, default: [] },
    rounds: { type: Array, default: [] }
});
const VirtualState = mongoose.model('VirtualState', virtualStateSchema);

const sharedSlipSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true },
    selections: { type: Array, default: [] },
    createdAt: { type: Date, default: Date.now, expires: 86400 } // Auto-delete after 24 hours
});
const SharedSlip = mongoose.model('SharedSlip', sharedSlipSchema);

// 🟢 ADMIN SCHEMAS (Fixed Outcomes & Config)
const fixedGameSchema = new mongoose.Schema({
    matchName: String, result_1x2: String, result_ou25: String, result_ggng: String, ft_score: String
});
const FixedGame = mongoose.model('FixedGame', fixedGameSchema);

const configSchema = new mongoose.Schema({
    aviatorWinChance: { type: Number, default: 30 },
    virtualsMargin: { type: Number, default: 1.20 }
});
const Config = mongoose.model('Config', configSchema);


// ==========================================
// TIME PARSING UTILITY (EAT ZONE)
// ==========================================
function parseGameTime(timeStr) {
    if (!timeStr) return new Date();
    
    const now = new Date(); 
    const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})/);
    
    if (timeMatch) {
        let hours = parseInt(timeMatch[1], 10);
        let mins = parseInt(timeMatch[2], 10);
        
        let year = now.getFullYear();
        let month = (now.getMonth() + 1).toString().padStart(2, '0');
        let date = now.getDate();
        
        if (timeStr.toLowerCase().includes('tomorrow')) {
            let tmrw = new Date(now);
            tmrw.setDate(tmrw.getDate() + 1);
            year = tmrw.getFullYear();
            month = (tmrw.getMonth() + 1).toString().padStart(2, '0');
            date = tmrw.getDate();
        }
        
        // Force EAT (UTC+03:00) so server math is perfect globally
        let dateString = `${year}-${month}-${date.toString().padStart(2, '0')}T${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:00+03:00`;
        
        let targetDate = new Date(dateString);
        if (isNaN(targetDate.getTime())) return new Date();
        
        return targetDate;
    }
    return new Date();
}


// ==========================================
// NOTIFICATIONS
// ==========================================
app.get('/api/notifications/:phone', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.params.phone });
        if (!user) return res.status(404).json({ success: false });
        
        const unreadNotifs = user.notifications.filter(n => n.isRead === false);
        
        if (unreadNotifs.length > 0) {
            user.notifications.forEach(n => n.isRead = true);
            user.markModified('notifications'); 
            await user.save();
        }
        res.json({ success: true, notifications: unreadNotifs.slice().reverse() });
    } catch (e) { 
        res.status(500).json({ success: false }); 
    }
});

async function sendPushNotification(phone, title, message, type) {
    try {
        let formattedPhone = phone.replace(/\D/g, '');
        if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
        if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) formattedPhone = '254' + formattedPhone;
        
        const notifObj = { 
            id: "N-" + Date.now(), 
            title, 
            message, 
            type, 
            isRead: false, 
            createdAt: new Date() 
        };
        
        await User.updateMany(
            { $or: [{ phone: phone }, { phone: formattedPhone }] }, 
            { $push: { notifications: notifObj } }
        );
    } catch(e) {}
}


// ==========================================
// AUTHENTICATION & FINANCE
// ==========================================
app.post('/api/register', async (req, res) => {
    try {
        const { phone, password, name, ref } = req.body;
        if (!phone || !password) return res.status(400).json({ success: false, message: 'Phone and password are required.' });
        
        const existingUser = await User.findOne({ phone });
        if (existingUser) return res.status(400).json({ success: false, message: 'Phone number already registered. Please login.' });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const newUser = new User({ phone, password: hashedPassword, name: name || 'New Player', balance: 0, bonusBalance: 0 });
        await newUser.save();

        sendTelegramMessage(`🟢 <b>NEW USER REGISTRATION</b>\n👤 Name: ${newUser.name}\n📱 Phone: ${newUser.phone}`);

        res.json({ success: true, user: { name: newUser.name, balance: newUser.balance, bonusBalance: newUser.bonusBalance, phone: newUser.phone } });
    } catch (error) { 
        res.status(500).json({ success: false, message: 'Server error' }); 
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        const user = await User.findOne({ phone });
        if (!user) return res.status(401).json({ success: false, message: 'Invalid phone number or password' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            if (password === user.password) {
                const salt = await bcrypt.genSalt(10);
                user.password = await bcrypt.hash(password, salt);
                await user.save();
            } else { 
                return res.status(401).json({ success: false, message: 'Invalid credentials' }); 
            }
        }
        res.json({ success: true, user: { name: user.name, balance: user.balance, bonusBalance: user.bonusBalance || 0, phone: user.phone } });
    } catch (error) { 
        res.status(500).json({ success: false, message: 'Server error' }); 
    }
});

app.post('/api/deposit', async (req, res) => {
    try {
        const { userPhone, amount, method } = req.body;
        if (amount < 10) return res.status(400).json({ success: false, message: 'Minimum deposit is 10 KES.' });
        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        let formattedPhone = userPhone.replace(/\D/g, ''); 
        if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
        if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) formattedPhone = '254' + formattedPhone;

        const reference = "DEP" + Date.now();
        const payload = {
            api_key: "MGPYA2NAwWcs", 
            email: "streetmaster878@gmail.com", 
            amount: amount, 
            msisdn: formattedPhone,
            callback_url: `${process.env.APP_URL || 'https://mega-ab5i.onrender.com'}/api/megapay/webhook`,
            description: "MegaOdds Deposit", 
            reference: reference
        };

        await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);
        await Transaction.create({ refId: reference, userPhone: user.phone, type: 'deposit', method: method || 'M-Pesa', amount: Number(amount), status: 'Pending' });

        res.status(200).json({ success: true, message: "STK Push Sent! Check your phone.", newBalance: user.balance, refId: reference });
    } catch (error) { 
        res.status(500).json({ success: false, message: "Gateway Error." }); 
    }
});

app.post('/api/megapay/webhook', async (req, res) => {
    res.status(200).send("OK");
    const data = req.body;
    try {
        if ((data.ResponseCode !== undefined ? data.ResponseCode : data.ResultCode) != 0) return; 

        const amount = parseFloat(data.TransactionAmount || data.amount || data.Amount);
        const receipt = data.TransactionReceipt || data.MpesaReceiptNumber;
        let rawPhone = (data.Msisdn || data.phone || data.PhoneNumber).toString();
        let phone0 = rawPhone.startsWith('254') ? '0' + rawPhone.substring(3) : rawPhone;
        let phone254 = rawPhone.startsWith('0') ? '254' + rawPhone.substring(1) : rawPhone;

        const user = await User.findOne({ $or: [{ phone: phone0 }, { phone: phone254 }, { phone: rawPhone }] });
        if (!user) return;

        const existingTx = await Transaction.findOne({ refId: receipt });
        if (existingTx) return;

        user.balance += amount;
        await user.save();
        await Transaction.create({ refId: receipt, userPhone: user.phone, type: "deposit", method: "M-Pesa", amount: amount, status: "Success" });
        sendPushNotification(user.phone, "Deposit Successful", `Your deposit of KES ${amount} has been credited.`, "deposit");
        
        sendTelegramMessage(`💵 <b>SUCCESSFUL DEPOSIT</b>\n📱 User: ${user.phone}\n💰 Amount: KES ${amount}\n🧾 Ref: ${receipt}`);

    } catch (err) {}
});

app.post('/api/withdraw', async (req, res) => {
    try {
        const { userPhone, amount, method } = req.body;
        const user = await User.findOne({ phone: userPhone });
        if (!user || user.balance < amount) return res.status(400).json({ success: false, message: 'Insufficient funds.' });

        user.balance -= Number(amount);
        await user.save();

        const refId = 'WD-' + Math.floor(100000 + Math.random() * 900000);
        await Transaction.create({ refId, userPhone, type: 'withdraw', method, amount: -Number(amount), status: 'Success' });
        sendPushNotification(user.phone, "Withdrawal Sent", `KES ${amount} has been sent to your M-Pesa.`, "withdraw");
        res.json({ success: true, newBalance: user.balance, refId });
    } catch (error) { 
        res.status(500).json({ success: false }); 
    }
});

app.get('/api/balance/:phone', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.params.phone });
        if (!user) return res.status(404).json({ success: false });
        res.json({ success: true, balance: user.balance, bonusBalance: user.bonusBalance || 0 });
    } catch (error) { 
        res.status(500).json({ success: false }); 
    }
});


// ==========================================
// UNIFIED GAMES FETCH 
// ==========================================
let cachedApiGames = [];
let lastApiFetchTime = 0;
const API_CACHE_DURATION = 5 * 60 * 1000;

app.get('/api/games', async (req, res) => {
    try {
        const dbGamesRaw = await LiveGame.find({ status: { $ne: 'FINISHED' }});
        let allGames = dbGamesRaw.map(g => g.toObject());

        if (ODDS_API_KEY && ODDS_API_KEY !== 'undefined') {
            const now = Date.now();
            
            if (now - lastApiFetchTime > API_CACHE_DURATION || cachedApiGames.length === 0) {
                try {
                    const [eplRes, ligaRes, upcomingRes] = await Promise.allSettled([
                        axios.get(`https://api.the-odds-api.com/v4/sports/soccer_epl/odds/`, { params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' } }),
                        axios.get(`https://api.the-odds-api.com/v4/sports/soccer_spain_la_liga/odds/`, { params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' } }),
                        axios.get(`https://api.the-odds-api.com/v4/sports/upcoming/odds/`, { params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' } })
                    ]);

                    let rawApiGames = [];
                    if (eplRes.status === 'fulfilled') rawApiGames = [...rawApiGames, ...eplRes.value.data];
                    if (ligaRes.status === 'fulfilled') rawApiGames = [...rawApiGames, ...ligaRes.value.data];
                    if (upcomingRes.status === 'fulfilled') rawApiGames = [...rawApiGames, ...upcomingRes.value.data];

                    const uniqueGamesMap = new Map();
                    rawApiGames.forEach(g => { if (!uniqueGamesMap.has(g.id)) uniqueGamesMap.set(g.id, g); });
                    const uniqueGames = Array.from(uniqueGamesMap.values());

                    cachedApiGames = uniqueGames.map(m => {
                        let h = "0.00", d = null, a = "0.00";
                        if (m.bookmakers && m.bookmakers.length > 0) {
                            const markets = m.bookmakers[0].markets;
                            const h2h = markets.find(mk => mk.key === 'h2h');
                            if (h2h && h2h.outcomes) {
                                const outHome = h2h.outcomes.find(o => o.name === m.home_team);
                                const outAway = h2h.outcomes.find(o => o.name === m.away_team);
                                const outDraw = h2h.outcomes.find(o => o.name.toLowerCase() === 'draw');
                                if(outHome) h = outHome.price.toFixed(2);
                                if(outAway) a = outAway.price.toFixed(2);
                                if(outDraw) d = outDraw.price.toFixed(2);
                            }
                        }

                        const matchTime = new Date(m.commence_time);
                        const diffMins = Math.floor((now - matchTime.getTime()) / 60000);
                        
                        let timeStr = matchTime.toLocaleTimeString('en-GB', {hour: '2-digit', minute:'2-digit', timeZone: 'Africa/Nairobi'});
                        let dateStr = matchTime.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'Africa/Nairobi' });

                        if (diffMins > 130) return null; 

                        let status = "upcoming", min = null, hs = 0, as = 0;
                        if (diffMins >= 0 && diffMins <= 120) {
                            status = "live";
                            timeStr = "Live";
                            min = diffMins > 45 && diffMins < 60 ? "HT" : diffMins > 90 ? "90+" : diffMins.toString();
                            const homeAdv = (1 / parseFloat(h)) > (1 / parseFloat(a)) ? 1.5 : 0.5;
                            hs = Math.floor((diffMins / 90) * homeAdv * Math.random() * 4);
                            as = Math.floor((diffMins / 90) * (2 - homeAdv) * Math.random() * 4);
                        }

                        return {
                            id: String(m.id), category: m.sport_title, league: m.sport_title, cc: 'INT',
                            home: m.home_team, away: m.away_team, odds: h, draw: d, away_odds: a,
                            startTime: matchTime, date: dateStr, time: timeStr, status: status, min: min, hs: hs, as: as
                        };
                    }).filter(game => game !== null);

                    lastApiFetchTime = now;
                } catch (apiErr) {}
            }
            allGames = [...allGames, ...cachedApiGames];
        }
        res.json({ success: true, games: allGames });
    } catch (error) { 
        res.status(500).json({ success: false }); 
    }
});

// ==========================================
// SHARE & LOAD BOOKING CODES
// ==========================================
app.post('/api/share-slip', async (req, res) => {
    try {
        const { selections } = req.body;
        if (!selections || selections.length === 0) return res.status(400).json({ success: false });

        const code = Math.random().toString(36).substring(2, 8).toUpperCase();
        await SharedSlip.create({ code, selections });
        
        res.json({ success: true, code });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/load-slip/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const slip = await SharedSlip.findOne({ code: code.toUpperCase() });
        
        if (!slip) return res.status(404).json({ success: false, message: 'Code not found or expired.' });
        
        res.json({ success: true, selections: slip.selections });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});


// ==========================================
// 🟢 SMART SPORTS BETTING & SETTLEMENT ENGINE 🟢
// ==========================================
app.post('/api/place-bet', async (req, res) => {
    try {
        const { userPhone, stake, selections, potentialWin, betType } = req.body;
        
        if (!stake || stake <= 0 || !selections || selections.length === 0) return res.status(400).json({ success: false, message: 'Invalid slip.' });

        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        const totalAvailable = user.balance + (user.bonusBalance || 0);
        if (totalAvailable < stake) return res.status(400).json({ success: false, message: 'Insufficient funds.' });

        let remainingStake = stake;
        if (user.bonusBalance >= remainingStake) {
            user.bonusBalance -= remainingStake; 
            remainingStake = 0;
        } else {
            remainingStake -= user.bonusBalance; 
            user.bonusBalance = 0;
            user.balance -= remainingStake; 
        }
        await user.save();

        const processedSelections = selections.map(s => ({
            ...s,
            matchId: String(s.matchId),
            legStatus: 'Open'
        }));

        const ticketId = 'TXN-' + Math.floor(Math.random() * 900000 + 100000);
        const newBet = new Bet({ ticketId, userPhone, stake, potentialWin, selections: processedSelections, type: betType || 'Sports' });
        await newBet.save();

        await Transaction.create({ refId: ticketId, userPhone, type: 'bet', method: `${betType || 'Sports'} Bet`, amount: -stake });
        
        sendTelegramMessage(`🎟️ <b>NEW BET PLACED</b>\n📱 User: ${userPhone}\n💰 Stake: KES ${stake}\n💸 Pot. Win: KES ${potentialWin}\n📌 Type: ${betType || 'Sports'}\n🎫 Ticket: ${ticketId}`);

        if (betType === 'Sports' || betType === 'Multi' || betType === 'Jackpot') {
            for (let s of processedSelections) {
                try {
                    const exists = await LiveGame.findOne({ id: String(s.matchId) });
                    if (!exists) {
                        const apiGame = cachedApiGames.find(g => String(g.id) === String(s.matchId));
                        if (apiGame) {
                            await LiveGame.create({
                                id: String(apiGame.id),
                                category: apiGame.category,
                                home: apiGame.home,
                                away: apiGame.away,
                                startTime: new Date(apiGame.startTime), 
                                status: 'upcoming'
                            });
                        } else {
                            await LiveGame.create({
                                id: String(s.matchId),
                                home: s.match ? s.match.split(' vs ')[0] : "Home",
                                away: s.match ? s.match.split(' vs ')[1] : "Away",
                                startTime: new Date(), 
                                status: 'upcoming'
                            });
                        }
                    }
                } catch(err) {}
            }
        }

        res.json({ success: true, newBalance: user.balance, newBonus: user.bonusBalance, ticketId: newBet.ticketId });
    } catch (error) { 
        res.status(500).json({ success: false }); 
    }
});

app.get('/api/bets/:phone', async (req, res) => {
    try {
        const bets = await Bet.find({ userPhone: req.params.phone }).sort({ createdAt: -1 });
        res.json({ success: true, bets });
    } catch (error) { 
        res.status(500).json({ success: false }); 
    }
});


// 🟢 SMART SETTLEMENT FUNCTION (Handles ugly string formats) 🟢
async function settleSportsBetsForMatch(matchId, hs, as) {
    try {
        console.log(`\n[SETTLE] 🔔 Triggered for Match ID: ${matchId} | Score: ${hs}-${as}`);
        
        const openBets = await Bet.find({ status: 'Open', type: { $in: ['Sports', 'Multi', 'Jackpot'] } });
        let matchedBets = openBets.filter(b => b.selections.some(s => String(s.matchId) === String(matchId)));
        
        for (let bet of matchedBets) {
            let betModified = false;
            let betLost = false;

            for (let sel of bet.selections) {
                if (String(sel.matchId) === String(matchId) && sel.legStatus === 'Open') {
                    let isWin = false;
                    
                    // 🟢 SMART PARSER: Deduce the intended market 
                    let rawPck = String(sel.pick || '');
                    let pck = rawPck.includes('-') ? rawPck.split('-')[1].trim().toUpperCase() : rawPck.trim().toUpperCase();
                    let mkt = sel.market;
                    
                    if (!mkt || mkt === '-') {
                        if (['1', 'X', '2', 'HOME', 'DRAW', 'AWAY'].includes(pck)) mkt = '1X2';
                        else if (['1X', '12', 'X2', '1/X', '1/2', 'X/2'].includes(pck)) mkt = 'Double Chance';
                        else if (['GG', 'NG', 'YES', 'NO'].includes(pck)) mkt = 'GG/NG';
                        else if (pck.includes('VER') || pck.includes('NDER')) mkt = 'O/U';
                        else mkt = 'Match Winner'; // Fallback
                    }
                    
                    if (mkt === '1X2' || mkt === 'Match Winner') {
                        if (['1', 'HOME'].includes(pck) || rawPck.endsWith('1')) { if (hs > as) isWin = true; }
                        else if (['X', 'DRAW'].includes(pck) || rawPck.endsWith('X')) { if (hs === as) isWin = true; }
                        else if (['2', 'AWAY'].includes(pck) || rawPck.endsWith('2')) { if (hs < as) isWin = true; }
                    } else if (mkt === 'GG/NG' || mkt.includes('Both Teams')) {
                        if (pck.includes('GG') || pck === 'YES') {
                            if (hs > 0 && as > 0) isWin = true;
                        } else {
                            if (hs === 0 || as === 0) isWin = true;
                        }
                    } else if (mkt.includes('Total Goals') || mkt.includes('O/U')) {
                        const total = hs + as;
                        if (pck.includes('2.5') && pck.includes('OVER') && total > 2.5) isWin = true;
                        if (pck.includes('2.5') && pck.includes('UNDER') && total < 2.5) isWin = true;
                        if (pck.includes('1.5') && pck.includes('OVER') && total > 1.5) isWin = true;
                        if (pck.includes('1.5') && pck.includes('UNDER') && total < 1.5) isWin = true;
                        if (pck.includes('3.5') && pck.includes('OVER') && total > 3.5) isWin = true;
                        if (pck.includes('3.5') && pck.includes('UNDER') && total < 3.5) isWin = true;
                    } else if (mkt === 'Double Chance') {
                        if (['1X', '1/X'].includes(pck)) { if (hs >= as) isWin = true; }
                        if (['12', '1/2'].includes(pck)) { if (hs !== as) isWin = true; }
                        if (['X2', 'X/2'].includes(pck)) { if (hs <= as) isWin = true; }
                    }

                    sel.legStatus = isWin ? 'Won' : 'Lost';
                    betModified = true;

                    if (!isWin) betLost = true;
                }
            }

            if (!betModified) continue;

            if (betLost) {
                bet.status = 'Lost';
                bet.markModified('selections');
                await bet.save();
                sendPushNotification(bet.userPhone, "Bet Lost 😔", `Ticket ${bet.ticketId} lost on leg: ${matchId}.`, "bet");
            } else {
                const allWon = bet.selections.every(s => s.legStatus === 'Won');
                if (allWon) {
                    bet.status = 'Won';
                    bet.markModified('selections');
                    await bet.save();
                    
                    const user = await User.findOne({ phone: bet.userPhone });
                    if (user) {
                        user.balance += bet.potentialWin;
                        await user.save();
                        
                        await Transaction.create({ refId: `WIN-${bet.ticketId}`, userPhone: user.phone, type: 'win', method: `${bet.type} Win`, amount: bet.potentialWin });
                        sendPushNotification(user.phone, "Bet Won! 🥳", `Ticket ${bet.ticketId} won KES ${bet.potentialWin}!`, "win");
                    }
                } else {
                    bet.markModified('selections');
                    await bet.save();
                }
            }
        }
    } catch (e) { console.error("Settlement error", e); }
}

// 🟢 ADMIN MANUAL SETTLEMENT 
app.post('/api/admin/set-result', async (req, res) => {
    try {
        const { matchId, hs, as } = req.body;
        const game = await LiveGame.findOne({ id: String(matchId) });
        if (game) {
            game.hs = Number(hs);
            game.as = Number(as);
            game.status = 'FINISHED';
            await game.save();
        }
        await settleSportsBetsForMatch(String(matchId), Number(hs), Number(as));
        res.json({ success: true, message: `Match ${matchId} updated to ${hs}-${as} and bets evaluated.` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 🟢 2-HOUR REAL SPORTS AUTO-SETTLER WITH CHEAT CODES
setInterval(async () => {
    try {
        const now = Date.now();
        const twoHoursAgo = new Date(now - (120 * 60000));
        
        const expiredGames = await LiveGame.find({ status: { $ne: 'FINISHED' }, startTime: { $lte: twoHoursAgo } });

        for (let game of expiredGames) {
            let forcedHs = null; let forcedAs = null;
            
            // Check if admin injected a cheat code for this specific match
            const fixedMatch = await FixedGame.findOne({ matchName: new RegExp(game.home, 'i') });
            if (fixedMatch) {
                if (fixedMatch.ft_score && fixedMatch.ft_score.includes('-')) {
                    forcedHs = parseInt(fixedMatch.ft_score.split('-')[0]);
                    forcedAs = parseInt(fixedMatch.ft_score.split('-')[1]);
                } else if (fixedMatch.result_1x2 === '1') { forcedHs = 2; forcedAs = 0; }
                else if (fixedMatch.result_1x2 === '2') { forcedHs = 0; forcedAs = 2; }
                else if (fixedMatch.result_1x2 === 'X') { forcedHs = 1; forcedAs = 1; }
            }
            
            game.hs = forcedHs !== null ? forcedHs : Math.floor(Math.random() * 4);
            game.as = forcedAs !== null ? forcedAs : Math.floor(Math.random() * 3);
            game.status = 'FINISHED';
            await game.save();

            await settleSportsBetsForMatch(String(game.id), game.hs, game.as);
        }
    } catch (e) {}
}, 60000); 

app.post('/api/cashout', async (req, res) => {
    try {
        const { ticketId, userPhone, amount } = req.body;
        
        if (ticketId && (ticketId.startsWith('CRASH-') || ticketId.startsWith('AV-'))) {
            const user = await User.findOne({ phone: userPhone });
            if (!user) return res.status(404).json({ success: false });
            
            user.balance += amount;
            await user.save();
            await Bet.updateOne({ ticketId: ticketId }, { $set: { status: 'Cashed Out' } });
            await Transaction.create({ refId: ticketId + '-WIN', userPhone, type: 'win', method: 'Crash Win', amount: amount });
            return res.json({ success: true, newBalance: user.balance });
        }

        const bet = await Bet.findOne({ ticketId: ticketId, userPhone: userPhone });
        if (!bet) return res.status(404).json({ success: false });
        if (bet.status !== 'Open') return res.status(400).json({ success: false, message: 'Ticket is not open.' });

        const user = await User.findOne({ phone: userPhone });
        bet.status = 'Cashed Out';
        await bet.save();

        user.balance += amount;
        await user.save();

        await Transaction.create({ refId: `CO-${ticketId}`, userPhone, type: 'cashout', method: 'Cashout', amount: amount });
        res.json({ success: true, newBalance: user.balance });
    } catch (error) { res.status(500).json({ success: false }); }
});


// ==========================================
// ADMIN ROUTES (USERS, CONFIG, FIXED GAMES)
// ==========================================
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await User.find({}).select('-password').sort({ createdAt: -1 });
        res.json({ success: true, users });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/admin/users/balance', async (req, res) => {
    try {
        const { phone, newBalance } = req.body;
        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ success: false });

        const oldBalance = user.balance;
        user.balance = Number(newBalance);
        await user.save();

        await Transaction.create({ refId: 'ADMIN-' + Math.floor(Math.random() * 900000), userPhone: phone, type: 'bonus', method: 'Admin Adjustment', amount: user.balance - oldBalance, status: 'Success' });
        res.json({ success: true, message: `Balance updated.` });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.delete('/api/admin/users/:phone', async (req, res) => {
    try {
        const user = await User.findOneAndDelete({ phone: req.params.phone });
        if (!user) return res.status(404).json({ success: false });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/push-alert', async (req, res) => {
    try {
        const { phone, title, message } = req.body;
        if (phone === 'ALL') {
            const bObj = { id: "BC-" + Date.now(), title, message, type: 'admin_alert', isRead: false, createdAt: new Date() };
            await User.updateMany({}, { $push: { notifications: bObj } });
        } else {
            await sendPushNotification(phone, title, message, 'admin_alert');
        }
        res.json({success: true, message: "Alert successfully dispatched!"});
    } catch(e) { res.status(500).json({success: false }); }
});

// Admin Inject Real Games
app.post('/api/games', async (req, res) => {
    try {
        const { games, mode } = req.body;
        if (mode === 'replace') await LiveGame.deleteMany({}); 
        const parsedGames = games.map(g => ({ ...g, startTime: g.startTime ? new Date(g.startTime) : parseGameTime(g.time) }));
        await LiveGame.insertMany(parsedGames); 
        res.json({ success: true, message: "Games updated in database" });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.delete('/api/games', async (req, res) => {
    try {
        await LiveGame.deleteMany({});
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

// Admin Cheat Codes / Fixed Games
app.get('/api/admin/fixed-games', async (req, res) => {
    try {
        const games = await FixedGame.find({});
        res.json({ success: true, games });
    } catch(e) { res.status(500).json({success: false}); }
});

app.post('/api/admin/fixed-games', async (req, res) => {
    try {
        const { games } = req.body;
        await FixedGame.insertMany(games);
        res.json({ success: true });
    } catch(e) { res.status(500).json({success: false}); }
});

app.delete('/api/admin/fixed-games', async (req, res) => {
    try {
        await FixedGame.deleteMany({});
        res.json({ success: true });
    } catch(e) { res.status(500).json({success: false}); }
});

// Admin Global Configurations
app.get('/api/admin/config', async (req, res) => {
    try {
        let config = await Config.findOne({});
        if(!config) { config = await Config.create({ aviatorWinChance: 30, virtualsMargin: 1.20 }); }
        res.json({ success: true, config });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/config', async (req, res) => {
    try {
        const { aviatorWinChance, virtualsMargin } = req.body;
        let config = await Config.findOne({});
        if(!config) config = new Config({});
        config.aviatorWinChance = aviatorWinChance;
        config.virtualsMargin = virtualsMargin;
        await config.save();
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});


// ==========================================
// VIRTUAL LEAGUE ENGINE (DB BACKED)
// ==========================================
const V_TEAMS = [
    { name: "Manchester Blue", color: "#6CABDD", short: "MCI" }, { name: "Manchester Reds", color: "#DA291C", short: "MUN" },
    { name: "Burnley", color: "#6C1D45", short: "BUR" }, { name: "Everton", color: "#003399", short: "EVE" },
    { name: "Sheffield U", color: "#EE2737", short: "SHU" }, { name: "London Blues", color: "#034694", short: "CHE" },
    { name: "Wolves", color: "#FDB913", short: "WOL" }, { name: "Liverpool", color: "#C8102E", short: "LIV" },
    { name: "West Ham", color: "#7A263A", short: "WHU" }, { name: "Leicester", color: "#003090", short: "LEI" },
    { name: "Newcastle", color: "#241F20", short: "NEW" }, { name: "Fulham", color: "#000000", short: "FUL" },
    { name: "Tottenham", color: "#132257", short: "TOT" }, { name: "Aston V", color: "#95BFE5", short: "AVL" },
    { name: "Palace", color: "#1B458F", short: "CRY" }, { name: "Leeds", color: "#FFCD00", short: "LEE" },
    { name: "West Brom", color: "#091453", short: "WBA" }, { name: "Southampton", color: "#D71920", short: "SOU" },
    { name: "Brighton", color: "#0057B8", short: "BHA" }, { name: "London Reds", color: "#E03A3E", short: "ARS" }
];

let vRounds = [];
let vStandings = [];
let currentVSeason = 1;

function generateVMatchEvents(homeProb) {
    let events = [];
    let hs = 0, as = 0;
    for(let min = 1; min <= 90; min++) {
        if(Math.random() < 0.035) { 
            if(Math.random() < homeProb) { hs++; events.push({ min, type: 'home' }); }
            else { as++; events.push({ min, type: 'away' }); }
        }
    }
    return { events, finalHs: hs, finalAs: as };
}

function createVirtualRound(matchday, startTime) {
    let shuffled = [...V_TEAMS].sort(() => 0.5 - Math.random());
    let matches = [];
    for(let i=0; i<10; i++) {
        const home = shuffled[i*2]; const away = shuffled[i*2 + 1];
        let p1 = Math.random() * 0.4 + 0.25; let p2 = Math.random() * 0.35 + 0.15; let px = Math.max(0.15, 1 - (p1 + p2)); 
        const margin = 1.12; 
        const hBase = (1 / (p1 * margin)).toFixed(2); const dBase = (1 / (px * margin)).toFixed(2); const aBase = (1 / (p2 * margin)).toFixed(2);
        
        matches.push({
            id: `MD${matchday}-${i}`, home: home, away: away, hs: 0, as: 0, hFlash: false, aFlash: false,
            events: generateVMatchEvents(p1 / (p1 + p2)).events,
            odds: {
                '1X2': [ {lbl: '1', val: hBase}, {lbl: 'X', val: dBase}, {lbl: '2', val: aBase} ],
                'O/U 2.5': [ {lbl: 'Over', val: (1.6 + Math.random()*0.5).toFixed(2)}, {lbl: 'Under', val: (1.7 + Math.random()*0.5).toFixed(2)} ],
                'GG/NG': [ {lbl: 'GG', val: (1.65 + Math.random()*0.5).toFixed(2)}, {lbl: 'NG', val: (1.8 + Math.random()*0.5).toFixed(2)} ],
                'Double Chance': [ {lbl: '1X', val: (1.2 + Math.random()*0.2).toFixed(2)}, {lbl: '12', val: (1.3 + Math.random()*0.2).toFixed(2)}, {lbl: 'X2', val: (1.4 + Math.random()*0.3).toFixed(2)} ]
            }
        });
    }
    return { id: 'R' + matchday, matchday: matchday, startTime: startTime, status: 'BETTING', liveMin: "0'", currentMinNum: 0, matches: matches };
}

async function bootVirtualEngine() {
    let state = await VirtualState.findOne({ stateId: 'MAIN_STATE' });
    
    if (!state || state.rounds.length === 0) {
        currentVSeason = 1;
        vStandings = V_TEAMS.map(t => ({ name: t.name, color: t.color, short: t.short, p: 0, pts: 0, gd: 0 })).sort((a,b) => a.name.localeCompare(b.name));
        
        let firstStart = Date.now() + 15000; 
        for(let i=1; i<=38; i++) {
            vRounds.push(createVirtualRound(i, firstStart + ((i-1) * 120000))); 
        }
        
        await VirtualState.create({ currentSeason: currentVSeason, standingsData: vStandings, rounds: vRounds });
    } else {
        currentVSeason = state.currentSeason;
        vStandings = state.standingsData;
        vRounds = state.rounds;
    }
}

bootVirtualEngine().then(() => {
    let vRestartFlag = false;

    setInterval(async () => {
        let now = Date.now();
        if (vRestartFlag || vRounds.length === 0) return;
        let dbNeedsUpdate = false;

        for (let r of vRounds) {
            let timeUntilLive = r.startTime - now;
            let oldStatus = r.status;

            if (timeUntilLive > 0) {
                r.status = 'BETTING';
            } else if (timeUntilLive <= 0 && timeUntilLive > -55000) {
                r.status = 'LIVE';
                let elapsedLive = Math.abs(timeUntilLive) / 1000; 
                let targetMinute = elapsedLive <= 25 ? Math.floor((elapsedLive / 25) * 45) : (elapsedLive > 25 && elapsedLive <= 30 ? 45 : Math.floor(45 + ((elapsedLive - 30) / 25) * 45));
                r.liveMin = elapsedLive > 25 && elapsedLive <= 30 ? "HT" : targetMinute + "'";

                r.matches.forEach(m => {
                    let oldHs = m.hs; let oldAs = m.as;
                    m.hs = m.events.filter(e => e.type === 'home' && e.min <= targetMinute).length;
                    m.as = m.events.filter(e => e.type === 'away' && e.min <= targetMinute).length;
                    m.hFlash = m.hs > oldHs; m.aFlash = m.as > oldAs;
                });
            } else if (timeUntilLive <= -55000 && r.status !== 'FINISHED') {
                r.status = 'FINISHED';
                r.liveMin = "FT";
                
                r.matches.forEach(m => {
                    m.hs = m.events.filter(e => e.type === 'home').length;
                    m.as = m.events.filter(e => e.type === 'away').length;
                    
                    let hTeam = vStandings.find(t => t.name === m.home.name);
                    let aTeam = vStandings.find(t => t.name === m.away.name);
                    if(hTeam && aTeam) {
                        hTeam.p++; aTeam.p++; hTeam.gd += (m.hs - m.as); aTeam.gd += (m.as - m.hs);
                        if(m.hs > m.as) hTeam.pts += 3; else if (m.hs < m.as) aTeam.pts += 3; else { hTeam.pts += 1; aTeam.pts += 1; }
                    }
                });

                dbNeedsUpdate = true;

                try {
                    const pendingVBets = await Bet.find({ type: 'Virtuals', status: 'Open' });
                    for (let b of pendingVBets) {
                        let betModified = false;
                        
                        for (let sel of b.selections) {
                            if (sel.legStatus === 'Open') {
                                const m = r.matches.find(mx => mx.id === sel.matchId);
                                if(m) {
                                    let isWin = false;
                                    const market = sel.market; const pick = sel.pick;
                                    if(market === '1X2') {
                                        if(pick === '1' && m.hs > m.as) isWin = true;
                                        if(pick === 'X' && m.hs === m.as) isWin = true;
                                        if(pick === '2' && m.hs < m.as) isWin = true;
                                    } else if (market === 'O/U 2.5') {
                                        if(pick === 'Over' && (m.hs + m.as) > 2.5) isWin = true;
                                        if(pick === 'Under' && (m.hs + m.as) < 2.5) isWin = true;
                                    } else if (market === 'GG/NG') {
                                        const gg = m.hs > 0 && m.as > 0;
                                        if(pick === 'GG' && gg) isWin = true;
                                        if(pick === 'NG' && !gg) isWin = true;
                                    } else if (market === 'Double Chance') {
                                        if(pick === '1X' && m.hs >= m.as) isWin = true;
                                        if(pick === '12' && m.hs !== m.as) isWin = true;
                                        if(pick === 'X2' && m.hs <= m.as) isWin = true;
                                    }
                                    
                                    sel.legStatus = isWin ? 'Won' : 'Lost';
                                    betModified = true;
                                }
                            }
                        }

                        if (betModified) {
                            b.markModified('selections');
                            
                            const anyLost = b.selections.some(s => s.legStatus === 'Lost');
                            const allWon = b.selections.every(s => s.legStatus === 'Won');
                            
                            if (anyLost) {
                                b.status = 'Lost';
                                await b.save();
                            } else if (allWon) {
                                b.status = 'Won';
                                await b.save();
                                await User.findOneAndUpdate({ phone: b.userPhone }, { $inc: { balance: b.potentialWin } });
                                await Transaction.create({ refId: `VWIN-${b.ticketId}`, userPhone: b.userPhone, type: 'win', method: 'Virtual Win', amount: b.potentialWin });
                            } else {
                                await b.save(); 
                            }
                        }
                    }
                } catch(e) {
                    console.error("Virtual Settlement Engine Error:", e);
                }

                try {
                    const resultsToSave = r.matches.map(m => ({
                        season: currentVSeason, matchday: r.matchday, home: m.home.short, away: m.away.short, hs: m.hs, as: m.as, odds: m.odds
                    }));
                    await VirtualResult.insertMany(resultsToSave);
                } catch(e) {}

                if (r.matchday === 38) {
                    vRestartFlag = true;
                    setTimeout(async () => {
                        currentVSeason++;
                        let firstStart = Date.now() + 15000; 
                        vRounds = [];
                        for(let i=1; i<=38; i++) vRounds.push(createVirtualRound(i, firstStart + ((i-1) * 120000))); 
                        vStandings = V_TEAMS.map(t => ({ name: t.name, color: t.color, short: t.short, p: 0, pts: 0, gd: 0 })).sort((a,b) => a.name.localeCompare(b.name));
                        await VirtualState.findOneAndUpdate({ stateId: 'MAIN_STATE' }, { currentSeason: currentVSeason, standingsData: vStandings, rounds: vRounds });
                        vRestartFlag = false;
                    }, 5000);
                }
            }
            if(oldStatus !== r.status) dbNeedsUpdate = true;
        }

        if (dbNeedsUpdate) {
            VirtualState.findOneAndUpdate({ stateId: 'MAIN_STATE' }, { currentSeason: currentVSeason, standingsData: vStandings, rounds: vRounds }).catch(e=>{});
        }
    }, 1000);
});

app.get('/api/virtuals/state', async (req, res) => {
    try {
        const dbResults = await VirtualResult.find({ season: currentVSeason }).sort({ createdAt: -1 }).limit(50);
        res.json({
            success: true, 
            state: {
                serverTime: Date.now(), 
                currentSeason: currentVSeason,
                rounds: vRounds, 
                standingsData: vStandings,
                resultsData: dbResults.map(r => ({ md: r.matchday, match: `${r.home} - ${r.away}`, score: `${r.hs} : ${r.as}` }))
            }
        });
    } catch(e) { 
        res.status(500).json({ success: false }); 
    }
});


// ==========================================
// CRASH GAME ENGINE
// ==========================================
let aviatorState = {
    status: 'WAITING', startTime: 0, crashPoint: 1.00, history: [1.24, 3.87, 11.20, 1.01, 6.42]
};

function runAviatorLoop() {
    if (aviatorState.status === 'WAITING') {
        
        aviatorState.crashPoint = Math.random() < 0.4 ? (1.00 + Math.random() * 0.5) : (1.5 + Math.random() * 10);
        sendTelegramMessage(`⚠️ <b>AVIATOR SIGNAL</b> ⚠️\n🚀 Next Round Crash Point: <b>${aviatorState.crashPoint.toFixed(2)}x</b>\n⏳ Round starting in 5 seconds...`);

        setTimeout(() => {
            aviatorState.status = 'FLYING';
            aviatorState.startTime = Date.now();
            const flightDuration = (Math.log(aviatorState.crashPoint) / 0.06) * 1000;
            
            setTimeout(() => {
                aviatorState.status = 'CRASHED';
                aviatorState.history.unshift(aviatorState.crashPoint);
                if(aviatorState.history.length > 20) aviatorState.history.pop();
                Bet.updateMany({ type: 'Aviator', status: 'Open' }, { $set: { status: 'Lost' } }).catch(e=>{});
                
                setTimeout(() => {
                    aviatorState.status = 'WAITING';
                    runAviatorLoop(); 
                }, 4000);
            }, flightDuration);
        }, 5000); 
    }
}
runAviatorLoop();

app.get('/api/aviator/state', (req, res) => {
    res.json({ 
        success: true, 
        status: aviatorState.status, 
        startTime: aviatorState.startTime, 
        crashPoint: aviatorState.status === 'CRASHED' ? aviatorState.crashPoint : null, 
        history: aviatorState.history 
    });
});

app.post('/api/aviator/bet', async (req, res) => {
    try {
        const { userPhone, amount } = req.body;
        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false });

        const betAmt = Number(amount);

        if (betAmt < 0) {
            user.balance += Math.abs(betAmt);
            await user.save();
            await Transaction.create({ refId: `CRASH-REF-${Date.now()}`, userPhone, type: 'refund', method: 'Crash Refund', amount: Math.abs(betAmt) });
            await Bet.findOneAndDelete({ userPhone: userPhone, type: 'Aviator', status: 'Open' });
            return res.json({ success: true, newBalance: user.balance });
        }

        const totalAvailable = user.balance + (user.bonusBalance || 0);

        if (totalAvailable >= betAmt) {
            let remainingStake = betAmt;
            if (user.bonusBalance >= remainingStake) { user.bonusBalance -= remainingStake; } 
            else { remainingStake -= user.bonusBalance; user.bonusBalance = 0; user.balance -= remainingStake; }
            await user.save();
            
            const tId = `CRASH-BET-${Date.now()}`;
            await Transaction.create({ refId: tId, userPhone, type: 'bet', method: 'Crash Bet', amount: -betAmt });
            await Bet.create({ ticketId: tId, userPhone: user.phone, stake: betAmt, potentialWin: 0, type: 'Aviator', status: 'Open', selections: [{ match: "Crash Round", market: "Crash", pick: "Auto", odds: 1.0 }] });

            sendTelegramMessage(`🛩️ <b>NEW AVIATOR BET</b>\n📱 User: ${user.phone}\n💰 Stake: KES ${betAmt}\n🎫 Ticket: ${tId}`);

            res.json({ success: true, newBalance: user.balance });
        } else {
            res.status(400).json({ success: false, message: "Insufficient Funds" });
        }
    } catch(e) { 
        res.status(500).json({ success: false }); 
    }
});


// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 MegaOdds Server live on port ${PORT}`);
});