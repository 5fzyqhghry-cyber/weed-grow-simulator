const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 80;

const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'players.json');

// 5 ступеней пирамиды: % от недельного заработка даунлайна
// L1: первые 10 прямых — 35%, остальные прямые — 15%
const REF_RATES = [0.35, 0.25, 0.15, 0.10, 0.05];
const REF_L1_FULL_SLOTS = 10; // первые 10 на полной ставке 35%
const REF_L1_EXTRA_RATE = 0.15;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '100kb' }));

function loadPlayers() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('loadPlayers:', e.message);
  }
  return {};
}

function savePlayers(players) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(players, null, 2), 'utf8');
  } catch (e) {
    console.error('savePlayers:', e.message);
  }
}

function getCurrentSeason() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getWeekId() {
  const d = new Date();
  // ISO-подобная неделя: год + номер недели
  const onejan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function calcRGServer(p) {
  const money = Math.max(0, Math.floor(Number(p.money) || 0));
  const netWorth = Math.max(money, Math.floor(Number(p.netWorth) || money));
  const level = Math.max(1, Math.min(100, Math.floor(Number(p.level) || 1)));
  const harvests = Math.max(0, Math.min(100000, Math.floor(Number(p.harvests) || 0)));
  const hybrids = Math.max(0, Math.min(500, Math.floor(Number(p.hybrids) || 0)));
  const achievements = Math.max(0, Math.min(50, Math.floor(Number(p.achievements) || 0)));
  const investments = Math.max(0, Math.min(20, Math.floor(Number(p.investments) || 0)));
  const heat = Math.max(0, Math.min(100, Math.floor(Number(p.heat) || 0)));
  const thcBonus = Math.max(0, Math.min(50, Math.floor(Number(p.thcBonus) || 0)));

  return Math.max(0, Math.floor(
    netWorth * 0.15 +
    level * 400 +
    harvests * 60 +
    hybrids * 1200 +
    achievements * 600 +
    investments * 3000 +
    thcBonus * 150 -
    heat * 40
  ));
}

function getDivision(rg) {
  if (rg >= 1500000) return { id: 'legendary', name: 'Legendary', emoji: '👑' };
  if (rg >= 400000)  return { id: 'platinum',  name: 'Platinum',  emoji: '💎' };
  if (rg >= 80000)   return { id: 'gold',      name: 'Gold',      emoji: '🥇' };
  if (rg >= 15000)   return { id: 'silver',    name: 'Silver',    emoji: '🥈' };
  return                   { id: 'bronze',    name: 'Bronze',    emoji: '🥉' };
}

/** Список прямых рефералов, отсортированный по дате регистрации */
function getDirectReferrals(players, userId) {
  return Object.values(players)
    .filter(p => p.referredBy === userId)
    .sort((a, b) => (a.registeredAt || 0) - (b.registeredAt || 0));
}

/** Аплайн: до 5 уровней вверх */
function getUpline(players, userId, maxLevels = 5) {
  const chain = [];
  let current = players[userId];
  let guard = 0;
  while (current && current.referredBy && guard < maxLevels) {
    const parent = players[current.referredBy];
    if (!parent) break;
    chain.push(parent.id);
    current = parent;
    guard++;
  }
  return chain;
}

/** Ставка для L1 с учётом «первых 10» */
function getL1Rate(directIndex) {
  return directIndex < REF_L1_FULL_SLOTS ? REF_RATES[0] : REF_L1_EXTRA_RATE;
}

/**
 * Считает незабранную комиссию за текущую неделю по всему даунлайну.
 * weeklyEarned — сколько игрок «заработал» за неделю (серверный учёт).
 */
function calcPendingCommission(players, userId) {
  const weekId = getWeekId();
  let total = 0;
  const breakdown = [
    { level: 1, rate: REF_RATES[0], count: 0, amount: 0 },
    { level: 2, rate: REF_RATES[1], count: 0, amount: 0 },
    { level: 3, rate: REF_RATES[2], count: 0, amount: 0 },
    { level: 4, rate: REF_RATES[3], count: 0, amount: 0 },
    { level: 5, rate: REF_RATES[4], count: 0, amount: 0 }
  ];

  // BFS даунлайна до 5 уровней
  let frontier = getDirectReferrals(players, userId).map(p => ({ id: p.id, level: 1, l1Index: null }));
  // проставим индекс среди прямых
  const directs = getDirectReferrals(players, userId);
  directs.forEach((p, i) => {
    const f = frontier.find(x => x.id === p.id);
    if (f) f.l1Index = i;
  });

  const visited = new Set([userId]);

  while (frontier.length) {
    const next = [];
    for (const node of frontier) {
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      const p = players[node.id];
      if (!p) continue;

      // Только текущая неделя
      const earned = (p.weekId === weekId) ? Math.max(0, Math.floor(p.weeklyEarned || 0)) : 0;
      if (earned > 0 && node.level >= 1 && node.level <= 5) {
        let rate = REF_RATES[node.level - 1];
        if (node.level === 1) {
          rate = getL1Rate(node.l1Index != null ? node.l1Index : 999);
        }
        const cut = Math.floor(earned * rate);
        total += cut;
        breakdown[node.level - 1].count += 1;
        breakdown[node.level - 1].amount += cut;
        if (node.level === 1) breakdown[0].rate = rate; // покажем актуальную
      }

      if (node.level < 5) {
        const children = getDirectReferrals(players, node.id);
        children.forEach(ch => {
          next.push({ id: ch.id, level: node.level + 1, l1Index: null });
        });
      }
    }
    frontier = next;
  }

  // Уже забранное за эту неделю
  const me = players[userId];
  const claimed = (me && me.commissionWeekId === weekId) ? Math.floor(me.commissionClaimed || 0) : 0;
  const pending = Math.max(0, total - claimed);

  return { weekId, total, claimed, pending, breakdown };
}

function countDownline(players, userId) {
  const counts = [0, 0, 0, 0, 0];
  let frontier = getDirectReferrals(players, userId).map(p => ({ id: p.id, level: 1 }));
  const visited = new Set([userId]);
  while (frontier.length) {
    const next = [];
    for (const node of frontier) {
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      if (node.level >= 1 && node.level <= 5) counts[node.level - 1]++;
      if (node.level < 5) {
        getDirectReferrals(players, node.id).forEach(ch => {
          next.push({ id: ch.id, level: node.level + 1 });
        });
      }
    }
    frontier = next;
  }
  return counts;
}

// ========== API ==========

app.post('/api/register', (req, res) => {
  try {
    const body = req.body || {};
    const userId = body.userId;
    if (!userId || typeof userId !== 'string' || userId.length > 64) {
      return res.status(400).json({ success: false, error: 'userId required' });
    }

    const players = loadPlayers();
    const now = Date.now();
    const season = getCurrentSeason();
    const weekId = getWeekId();
    const existing = players[userId] || {};

    const money = Math.max(0, Math.floor(Number(body.money) || 0));
    const netWorth = Math.max(money, Math.floor(Number(body.netWorth) || money));
    const level = Math.max(1, Math.min(100, Math.floor(Number(body.level) || 1)));
    const energy = Math.max(0, Math.floor(Number(body.energy) || 0));
    const harvests = Math.max(0, Math.floor(Number(body.harvests) || 0));
    const hybrids = Math.max(0, Math.floor(Number(body.hybrids) || 0));
    const achievements = Math.max(0, Math.floor(Number(body.achievements) || 0));
    const investments = Math.max(0, Math.floor(Number(body.investments) || 0));
    const heat = Math.max(0, Math.min(100, Math.floor(Number(body.heat) || 0)));
    const thcBonus = Math.max(0, Math.floor(Number(body.thcBonus) || 0));
    const totalEarned = Math.max(0, Math.floor(Number(body.totalEarned) || 0));

    // Реферер — только при первой регистрации и если существует
    let referredBy = existing.referredBy || null;
    if (!referredBy && body.referredBy && body.referredBy !== userId) {
      const parentId = String(body.referredBy).slice(0, 64);
      if (players[parentId]) {
        // Защита от циклов: parent не должен быть в нашем будущем даунлайне (нас ещё нет)
        referredBy = parentId;
      }
    }

    // Недельный заработок: прирост totalEarned за текущую неделю
    let weeklyEarned = existing.weeklyEarned || 0;
    let lastTotalEarned = existing.lastTotalEarned || 0;
    let playerWeekId = existing.weekId || weekId;

    if (playerWeekId !== weekId) {
      // Новая неделя
      weeklyEarned = 0;
      playerWeekId = weekId;
      lastTotalEarned = totalEarned; // база недели
    } else {
      if (totalEarned > lastTotalEarned) {
        const delta = totalEarned - lastTotalEarned;
        // Античит: не больше 500к за один синк
        weeklyEarned += Math.min(delta, 500000);
        lastTotalEarned = totalEarned;
      } else if (totalEarned > 0 && lastTotalEarned === 0) {
        lastTotalEarned = totalEarned;
      }
    }

    const profile = {
      id: userId,
      name: String(body.userName || existing.name || 'Игрок').slice(0, 32),
      money,
      netWorth,
      level,
      energy,
      harvests,
      hybrids,
      achievements,
      investments,
      heat,
      thcBonus,
      totalEarned,
      lastTotalEarned,
      weeklyEarned,
      weekId: playerWeekId,
      referredBy,
      registeredAt: existing.registeredAt || now,
      lastActive: now,
      commissionClaimed: existing.commissionClaimed || 0,
      commissionWeekId: existing.commissionWeekId || null,
      totalCommissionEarned: existing.totalCommissionEarned || 0
    };

    profile.rg = calcRGServer(profile);
    profile.division = getDivision(profile.rg).id;

    if (existing.season !== season) {
      profile.season = season;
      profile.seasonRg = profile.rg;
    } else {
      profile.season = season;
      profile.seasonRg = Math.max(existing.seasonRg || 0, profile.rg);
    }

    const year = String(new Date().getFullYear());
    if (existing.year !== year) {
      profile.year = year;
      profile.yearRg = profile.rg;
    } else {
      profile.year = year;
      profile.yearRg = Math.max(existing.yearRg || 0, profile.rg);
    }

    players[userId] = profile;
    savePlayers(players);

    const commission = calcPendingCommission(players, userId);
    const downline = countDownline(players, userId);

    return res.json({
      success: true,
      rg: profile.rg,
      seasonRg: profile.seasonRg,
      division: profile.division,
      referredBy: profile.referredBy,
      referral: {
        downline,
        pending: commission.pending,
        claimed: commission.claimed,
        weekId: commission.weekId,
        breakdown: commission.breakdown,
        totalEarned: profile.totalCommissionEarned || 0
      }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: 'server error' });
  }
});

function buildLeaderboard(period) {
  const players = loadPlayers();
  const list = Object.values(players);
  const season = getCurrentSeason();

  list.forEach(p => {
    if (p.rg == null) p.rg = calcRGServer(p);
  });

  if (period === 'yearly') {
    list.sort((a, b) => (b.yearRg || b.rg || 0) - (a.yearRg || a.rg || 0));
  } else {
    list.sort((a, b) => {
      const ar = (a.season === season ? (a.seasonRg || a.rg) : 0) || 0;
      const br = (b.season === season ? (b.seasonRg || b.rg) : 0) || 0;
      return br - ar;
    });
  }

  return list.slice(0, 100).map(p => {
    const score = period === 'yearly'
      ? (p.yearRg || p.rg || 0)
      : (p.season === season ? (p.seasonRg || p.rg || 0) : 0);
    const div = getDivision(score);
    return {
      id: p.id,
      name: p.name,
      level: p.level || 1,
      money: p.money || 0,
      rg: score,
      division: div.id,
      divisionEmoji: div.emoji,
      harvests: p.harvests || 0,
      hybrids: p.hybrids || 0
    };
  });
}

app.get('/api/leaderboard/monthly', (req, res) => {
  try {
    res.json({ players: buildLeaderboard('monthly'), season: getCurrentSeason() });
  } catch (e) {
    res.status(500).json({ players: [] });
  }
});

app.get('/api/leaderboard/yearly', (req, res) => {
  try {
    res.json({ players: buildLeaderboard('yearly'), year: String(new Date().getFullYear()) });
  } catch (e) {
    res.status(500).json({ players: [] });
  }
});

app.get('/api/leaderboard', (req, res) => {
  const period = req.query.period === 'yearly' ? 'yearly' : 'monthly';
  try {
    res.json({ players: buildLeaderboard(period) });
  } catch (e) {
    res.status(500).json({ players: [] });
  }
});

/** Статистика реферальной сети */
app.get('/api/referral/:userId', (req, res) => {
  try {
    const userId = String(req.params.userId || '').slice(0, 64);
    const players = loadPlayers();
    if (!players[userId]) {
      return res.json({
        success: true,
        downline: [0, 0, 0, 0, 0],
        pending: 0,
        claimed: 0,
        totalEarned: 0,
        breakdown: [],
        directs: [],
        rates: REF_RATES,
        weekId: getWeekId()
      });
    }

    const commission = calcPendingCommission(players, userId);
    const downline = countDownline(players, userId);
    const directs = getDirectReferrals(players, userId).slice(0, 50).map((p, i) => ({
      id: p.id,
      name: p.name,
      level: p.level || 1,
      weeklyEarned: (p.weekId === getWeekId() ? p.weeklyEarned : 0) || 0,
      rate: getL1Rate(i),
      registeredAt: p.registeredAt
    }));

    res.json({
      success: true,
      downline,
      pending: commission.pending,
      claimed: commission.claimed,
      totalEarned: players[userId].totalCommissionEarned || 0,
      breakdown: commission.breakdown,
      directs,
      rates: REF_RATES,
      weekId: commission.weekId
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: 'server error' });
  }
});

/** Забрать недельную комиссию */
app.post('/api/referral/claim', (req, res) => {
  try {
    const userId = req.body && req.body.userId;
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

    const players = loadPlayers();
    const me = players[userId];
    if (!me) return res.status(404).json({ success: false, error: 'player not found' });

    const commission = calcPendingCommission(players, userId);
    if (commission.pending <= 0) {
      return res.json({ success: true, claimed: 0, message: 'Нечего забирать' });
    }

    const amount = commission.pending;
    me.commissionClaimed = (me.commissionClaimed || 0) + amount;
    me.commissionWeekId = commission.weekId;
    me.totalCommissionEarned = (me.totalCommissionEarned || 0) + amount;
    // Деньги начисляем на серверный баланс (клиент тоже добавит у себя)
    me.money = Math.floor((me.money || 0) + amount);
    players[userId] = me;
    savePlayers(players);

    console.log(`Claim ${userId} +${amount}$ commission`);
    return res.json({
      success: true,
      claimed: amount,
      totalEarned: me.totalCommissionEarned,
      breakdown: commission.breakdown
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: 'server error' });
  }
});

// Статика: отдаём игру (index.html) с того же домена
app.use(express.static(__dirname, {
  index: false,
  extensions: ['html']
}));

app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  // Если index.html ещё не залит — покажем статус API
  res.json({
    status: 'ok',
    service: 'Weed Grow Simulator Backend v3',
    message: 'index.html not found — upload the game file',
    season: getCurrentSeason(),
    weekId: getWeekId(),
    referralRates: REF_RATES
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Weed Grow Simulator Backend v3',
    season: getCurrentSeason(),
    weekId: getWeekId(),
    referralRates: REF_RATES,
    endpoints: [
      'POST /api/register',
      'GET /api/leaderboard/monthly',
      'GET /api/leaderboard/yearly',
      'GET /api/referral/:userId',
      'POST /api/referral/claim'
    ]
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend v3 on port ${PORT}, data: ${DB_FILE}`);
});
