const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 80;

// Папка для постоянного хранения (Amvera монтирует /data)
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'players.json');

// Создаём папку если нет
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());

// ========== Хранение ==========
function loadPlayers() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Error loading players:', e.message);
  }
  return {};
}

function savePlayers(players) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(players, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving players:', e.message);
  }
}

// ========== API ==========

// Регистрация / обновление профиля
app.post('/api/register', (req, res) => {
  try {
    const { userId, userName, money, level, energy, harvests } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId required' });
    }

    const players = loadPlayers();
    const now = Date.now();

    const existing = players[userId] || {};

    players[userId] = {
      id: userId,
      name: userName || existing.name || 'Игрок',
      money: Math.floor(Number(money) || existing.money || 0),
      level: Math.floor(Number(level) || existing.level || 1),
      energy: Math.floor(Number(energy) || existing.energy || 100),
      harvests: Math.floor(Number(harvests) || existing.harvests || 0),
      registeredAt: existing.registeredAt || now,
      lastActive: now,
      monthlyMoney: Math.floor(Number(money) || existing.monthlyMoney || 0),
      monthlyUpdated: existing.monthlyUpdated || now
    };

    // Сброс месячного рейтинга если сменился месяц
    const lastMonth = new Date(players[userId].monthlyUpdated).getMonth();
    const currentMonth = new Date().getMonth();
    if (lastMonth !== currentMonth) {
      players[userId].monthlyMoney = Math.floor(Number(money) || 0);
      players[userId].monthlyUpdated = now;
    } else {
      if ((Number(money) || 0) > (players[userId].monthlyMoney || 0)) {
        players[userId].monthlyMoney = Math.floor(Number(money) || 0);
      }
    }

    savePlayers(players);

    console.log(`Registered/updated: ${userId} (${players[userId].name}) money=${players[userId].money}`);
    return res.json({ success: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: 'server error' });
  }
});

// Таблица лидеров
function getLeaderboard(period = 'monthly') {
  const players = loadPlayers();
  const list = Object.values(players);

  if (period === 'yearly' || period === 'all') {
    list.sort((a, b) => (b.money || 0) - (a.money || 0));
  } else {
    list.sort((a, b) => (b.monthlyMoney || 0) - (a.monthlyMoney || 0));
  }

  return list.slice(0, 100).map(p => ({
    id: p.id,
    name: p.name,
    level: p.level || 1,
    money: period === 'monthly' ? (p.monthlyMoney || 0) : (p.money || 0)
  }));
}

app.get('/api/leaderboard/monthly', (req, res) => {
  try {
    const players = getLeaderboard('monthly');
    res.json({ players });
  } catch (e) {
    console.error(e);
    res.status(500).json({ players: [], error: 'server error' });
  }
});

app.get('/api/leaderboard/yearly', (req, res) => {
  try {
    const players = getLeaderboard('yearly');
    res.json({ players });
  } catch (e) {
    console.error(e);
    res.status(500).json({ players: [], error: 'server error' });
  }
});

app.get('/api/leaderboard', (req, res) => {
  const period = req.query.period || 'monthly';
  try {
    const players = getLeaderboard(period);
    res.json({ players });
  } catch (e) {
    res.status(500).json({ players: [] });
  }
});

// Healthcheck
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Weed Grow Simulator Backend',
    endpoints: [
      'POST /api/register',
      'GET /api/leaderboard/monthly',
      'GET /api/leaderboard/yearly'
    ]
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend running on port ${PORT}`);
  console.log(`Data file: ${DB_FILE}`);
});
