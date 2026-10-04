const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 80;

const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'players.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');
const PM_FILE = path.join(DATA_DIR, 'pms.json');

// 5 ступеней пирамиды: % от недельного заработка даунлайна
// L1: первые 10 прямых — 35%, остальные прямые — 15%
const REF_RATES = [0.35, 0.25, 0.15, 0.10, 0.05];
const REF_L1_FULL_SLOTS = 10; // первые 10 на полной ставке 35%
const REF_L1_EXTRA_RATE = 0.15;
const REF_SIGNUP_BONUS = 200; // бонус пригласившему за каждого нового реферала

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
  const uid = String(userId);
  return Object.values(players)
    .filter(p => p.referredBy != null && String(p.referredBy) === uid)
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
    const userId = String(body.userId == null ? '' : body.userId).trim();
    if (!userId || userId.length > 64 || userId === 'undefined' || userId === 'null') {
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

    // Реферер — только один раз, нельзя сменить
    let referredBy = existing.referredBy || null;
    let referralBound = false;
    if (!referredBy && body.referredBy) {
      let parentId = String(body.referredBy).slice(0, 64).trim();
      if (parentId.startsWith('ref_')) parentId = parentId.slice(4);
      else if (parentId.startsWith('ref') && /^ref[\d]/.test(parentId)) parentId = parentId.slice(3);
      parentId = parentId.replace(/[^a-zA-Z0-9_\-]/g, '');
      if (parentId && parentId !== userId && parentId.length >= 2 && parentId !== 'null' && parentId !== 'undefined') {
        const parent = players[parentId];
        // цикл: parent уже чей-то реферал этого userId
        if (parent && String(parent.referredBy) === String(userId)) {
          console.log('REF cycle ignored', userId, parentId);
        } else {
          referredBy = String(parentId);
          referralBound = true;
          console.log(`REF BIND ${userId} <- ${referredBy} (parent in db: ${!!players[referredBy]})`);

          // Создать «заглушку» родителя если ещё не регистрировался — чтобы сеть считалась
          if (!players[referredBy]) {
            players[referredBy] = {
              id: referredBy,
              name: 'Игрок',
              money: 0, netWorth: 0, level: 1, energy: 0,
              harvests: 0, hybrids: 0, achievements: 0, investments: 0,
              heat: 0, thcBonus: 0, totalEarned: 0, lastTotalEarned: 0,
              weeklyEarned: 0, weekId: weekId, referredBy: null,
              registeredAt: now, lastActive: now,
              commissionClaimed: 0, commissionWeekId: null,
              totalCommissionEarned: 0, signupBonusPending: 0,
              friends: [], friendRequests: [], friendOutgoing: [],
              rg: 0, division: 'bronze', season: season, seasonRg: 0
            };
          }

          // Бонус пригласившему за регистрацию реферала
          const par = players[referredBy];
          par.signupBonusPending = Math.floor(par.signupBonusPending || 0) + REF_SIGNUP_BONUS;
          par.totalCommissionEarned = Math.floor(par.totalCommissionEarned || 0); // не увеличиваем до claim
          // авто-друзья
          if (!Array.isArray(par.friends)) par.friends = [];
          if (!par.friends.includes(userId)) par.friends.push(userId);
          players[referredBy] = par;
        }
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
      referralBoundAt: existing.referralBoundAt || (referralBound ? now : null),
      registeredAt: existing.registeredAt || now,
      lastActive: now,
      commissionClaimed: existing.commissionClaimed || 0,
      commissionWeekId: existing.commissionWeekId || null,
      totalCommissionEarned: existing.totalCommissionEarned || 0,
      friends: Array.isArray(existing.friends) ? existing.friends : [],
      friendRequests: Array.isArray(existing.friendRequests) ? existing.friendRequests : [],
      friendOutgoing: Array.isArray(existing.friendOutgoing) ? existing.friendOutgoing : [],
      signupBonusPending: existing.signupBonusPending || 0
    };
    // Если только что привязались — добавить родителя в друзья
    if (referralBound && referredBy) {
      if (!profile.friends.includes(referredBy)) profile.friends.push(referredBy);
    }

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
      referralBound: referralBound || false,
      parentExists: !!(profile.referredBy && players[profile.referredBy]),
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
    const weekId = getWeekId();
    const directs = getDirectReferrals(players, userId).slice(0, 50).map((p, i) => ({
      id: p.id,
      name: p.name,
      level: p.level || 1,
      money: p.money || 0,
      weeklyEarned: (p.weekId === weekId ? p.weeklyEarned : 0) || 0,
      rate: getL1Rate(i),
      registeredAt: p.registeredAt,
      lastActive: p.lastActive || 0,
      online: p.lastActive && (Date.now() - p.lastActive < 5 * 60 * 1000)
    }));

    res.json({
      success: true,
      downline,
      pending: Math.floor(commission.pending || 0) + Math.floor(players[userId].signupBonusPending || 0),
      signupBonusPending: Math.floor(players[userId].signupBonusPending || 0),
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
    const signupBonus = Math.floor(me.signupBonusPending || 0);
    const amount = Math.floor(commission.pending || 0) + signupBonus;
    if (amount <= 0) {
      return res.json({ success: true, claimed: 0, message: 'Нечего забирать. Бонус за рефералов появится после их регистрации, комиссия — с их заработка за неделю.' });
    }

    if (commission.pending > 0) {
      me.commissionClaimed = (me.commissionClaimed || 0) + commission.pending;
      me.commissionWeekId = commission.weekId;
    }
    me.signupBonusPending = 0;
    me.totalCommissionEarned = (me.totalCommissionEarned || 0) + amount;
    me.money = Math.floor((me.money || 0) + amount);
    players[userId] = me;
    savePlayers(players);

    console.log(`Claim ${userId} +${amount}$ (comm ${commission.pending} + signup ${signupBonus})`);
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


// ========== ДРУЗЬЯ ==========
const ONLINE_MS = 5 * 60 * 1000;

function findPlayerByName(players, name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  // точное совпадение, потом частичное
  let found = Object.values(players).find(p => String(p.name || '').toLowerCase() === n);
  if (found) return found;
  found = Object.values(players).find(p => String(p.name || '').toLowerCase().includes(n));
  return found || null;
}

function ensureFriendArrays(p) {
  if (!Array.isArray(p.friends)) p.friends = [];
  if (!Array.isArray(p.friendRequests)) p.friendRequests = []; // входящие: { fromId, fromName, at }
  if (!Array.isArray(p.friendOutgoing)) p.friendOutgoing = []; // исходящие toId
}

function isOnline(p) {
  return !!(p && p.lastActive && (Date.now() - p.lastActive < ONLINE_MS));
}

/** Отправить заявку в друзья по имени или id */
app.post('/api/friends/request', (req, res) => {
  try {
    const fromId = String(req.body?.fromId || '').trim();
    const toNameOrId = String(req.body?.to || '').trim();
    if (!fromId || !toNameOrId) {
      return res.status(400).json({ success: false, error: 'fromId and to required' });
    }
    const players = loadPlayers();
    const me = players[fromId];
    if (!me) return res.status(404).json({ success: false, error: 'Сначала зарегистрируйся в рейтинге' });

    ensureFriendArrays(me);
    let target = players[toNameOrId] || findPlayerByName(players, toNameOrId);
    if (!target) {
      return res.status(404).json({ success: false, error: 'Игрок не найден. Он должен быть в рейтинге.' });
    }
    if (target.id === fromId) {
      return res.status(400).json({ success: false, error: 'Нельзя добавить себя' });
    }
    ensureFriendArrays(target);

    if (me.friends.includes(target.id)) {
      return res.json({ success: false, error: 'Уже в друзьях' });
    }
    // уже есть входящая от него — сразу дружим
    const incomingFromTarget = target.friendRequests.find(r => r.fromId === fromId);
    // wait - if target already sent me a request, accept it
    const myIncoming = me.friendRequests.find(r => r.fromId === target.id);
    if (myIncoming) {
      me.friends.push(target.id);
      target.friends.push(fromId);
      me.friendRequests = me.friendRequests.filter(r => r.fromId !== target.id);
      target.friendOutgoing = (target.friendOutgoing || []).filter(id => id !== fromId);
      players[fromId] = me;
      players[target.id] = target;
      savePlayers(players);
      return res.json({ success: true, autoAccepted: true, friend: { id: target.id, name: target.name } });
    }

    if ((me.friendOutgoing || []).includes(target.id) ||
        target.friendRequests.some(r => r.fromId === fromId)) {
      return res.json({ success: false, error: 'Заявка уже отправлена' });
    }

    target.friendRequests.push({
      fromId: fromId,
      fromName: me.name || 'Игрок',
      at: Date.now()
    });
    if (!me.friendOutgoing) me.friendOutgoing = [];
    me.friendOutgoing.push(target.id);

    players[fromId] = me;
    players[target.id] = target;
    savePlayers(players);

    console.log(`FRIEND REQ ${fromId} -> ${target.id}`);
    return res.json({
      success: true,
      message: 'Заявка отправлена',
      to: { id: target.id, name: target.name }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: 'server error' });
  }
});

/** Принять / отклонить заявку */
app.post('/api/friends/respond', (req, res) => {
  try {
    const userId = String(req.body?.userId || '').trim();
    const fromId = String(req.body?.fromId || '').trim();
    const accept = !!req.body?.accept;
    if (!userId || !fromId) {
      return res.status(400).json({ success: false, error: 'userId and fromId required' });
    }
    const players = loadPlayers();
    const me = players[userId];
    const other = players[fromId];
    if (!me) return res.status(404).json({ success: false, error: 'player not found' });
    ensureFriendArrays(me);
    if (other) ensureFriendArrays(other);

    const had = me.friendRequests.some(r => r.fromId === fromId);
    me.friendRequests = me.friendRequests.filter(r => r.fromId !== fromId);
    if (other) {
      other.friendOutgoing = (other.friendOutgoing || []).filter(id => id !== userId);
    }

    if (accept && had && other) {
      if (!me.friends.includes(fromId)) me.friends.push(fromId);
      if (!other.friends.includes(userId)) other.friends.push(userId);
    }

    players[userId] = me;
    if (other) players[fromId] = other;
    savePlayers(players);

    return res.json({
      success: true,
      accepted: accept && had,
      friend: accept && other ? { id: other.id, name: other.name } : null
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: 'server error' });
  }
});

/** Удалить из друзей */
app.post('/api/friends/remove', (req, res) => {
  try {
    const userId = String(req.body?.userId || '').trim();
    const friendId = String(req.body?.friendId || '').trim();
    if (!userId || !friendId) {
      return res.status(400).json({ success: false, error: 'userId and friendId required' });
    }
    const players = loadPlayers();
    const me = players[userId];
    const other = players[friendId];
    if (me) {
      ensureFriendArrays(me);
      me.friends = me.friends.filter(id => id !== friendId);
      players[userId] = me;
    }
    if (other) {
      ensureFriendArrays(other);
      other.friends = other.friends.filter(id => id !== userId);
      players[friendId] = other;
    }
    savePlayers(players);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: 'server error' });
  }
});

/** Список друзей + входящие заявки + онлайн */
app.get('/api/friends/:userId', (req, res) => {
  try {
    const userId = String(req.params.userId || '').slice(0, 64);
    const players = loadPlayers();
    const me = players[userId];
    if (!me) {
      return res.json({ success: true, friends: [], requests: [], outgoing: [] });
    }
    ensureFriendArrays(me);

    const friends = me.friends.map(fid => {
      const p = players[fid];
      if (!p) return { id: fid, name: 'Игрок', level: 1, money: 0, online: false, lastActive: 0 };
      return {
        id: p.id,
        name: p.name || 'Игрок',
        level: p.level || 1,
        money: p.money || 0,
        online: isOnline(p),
        lastActive: p.lastActive || 0
      };
    }).filter(Boolean);

    const requests = (me.friendRequests || []).map(r => ({
      fromId: r.fromId,
      fromName: r.fromName || (players[r.fromId] && players[r.fromId].name) || 'Игрок',
      at: r.at || 0,
      online: players[r.fromId] ? isOnline(players[r.fromId]) : false
    }));

    const outgoing = (me.friendOutgoing || []).map(oid => {
      const p = players[oid];
      return {
        id: oid,
        name: p ? p.name : 'Игрок',
        online: p ? isOnline(p) : false
      };
    });

    // touch lastActive when checking friends (online heartbeat)
    me.lastActive = Date.now();
    players[userId] = me;
    savePlayers(players);

    res.json({ success: true, friends, requests, outgoing });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: 'server error' });
  }
});

/** Поиск игроков по имени */
app.get('/api/players/search', (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q || q.length < 1) return res.json({ players: [] });
    const players = loadPlayers();
    const list = Object.values(players)
      .filter(p => String(p.name || '').toLowerCase().includes(q))
      .slice(0, 20)
      .map(p => ({
        id: p.id,
        name: p.name,
        level: p.level || 1,
        online: isOnline(p)
      }));
    res.json({ players: list });
  } catch (e) {
    res.json({ players: [] });
  }
});



// ========== ОНЛАЙН + ЧАТ ==========
function loadChat() {
  try {
    if (fs.existsSync(CHAT_FILE)) return JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
  } catch (e) {}
  return { global: [] };
}
function saveChat(data) {
  try { fs.writeFileSync(CHAT_FILE, JSON.stringify(data), 'utf8'); } catch (e) { console.error(e); }
}
function loadPMs() {
  try {
    if (fs.existsSync(PM_FILE)) return JSON.parse(fs.readFileSync(PM_FILE, 'utf8'));
  } catch (e) {}
  return {};
}
function savePMs(data) {
  try { fs.writeFileSync(PM_FILE, JSON.stringify(data), 'utf8'); } catch (e) { console.error(e); }
}
function pmKey(a, b) {
  return [String(a), String(b)].sort().join('_');
}

/** Кто онлайн сейчас */
app.get('/api/online', (req, res) => {
  try {
    const players = loadPlayers();
    const now = Date.now();
    const list = Object.values(players)
      .filter(p => p.lastActive && (now - p.lastActive < ONLINE_MS))
      .sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0))
      .slice(0, 50)
      .map(p => ({
        id: p.id,
        name: p.name || 'Игрок',
        level: p.level || 1,
        lastActive: p.lastActive
      }));
    res.json({ success: true, online: list, count: list.length });
  } catch (e) {
    res.json({ success: true, online: [], count: 0 });
  }
});

/** Глобальный чат — последние сообщения */
app.get('/api/chat/global', (req, res) => {
  try {
    const chat = loadChat();
    const msgs = (chat.global || []).slice(-40);
    res.json({ success: true, messages: msgs });
  } catch (e) {
    res.json({ success: true, messages: [] });
  }
});

/** Отправить в глобальный чат */
app.post('/api/chat/global', (req, res) => {
  try {
    const userId = String(req.body?.userId || '').trim();
    const text = String(req.body?.text || '').trim().slice(0, 200);
    if (!userId || !text) return res.status(400).json({ success: false, error: 'empty' });
    const players = loadPlayers();
    const me = players[userId];
    if (!me) return res.status(403).json({ success: false, error: 'Сначала зарегистрируйся' });
    me.lastActive = Date.now();
    players[userId] = me;
    savePlayers(players);

    const chat = loadChat();
    if (!Array.isArray(chat.global)) chat.global = [];
    const msg = {
      id: 'g_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      from: userId,
      name: String(me.name || 'Игрок').slice(0, 24),
      text,
      time: Date.now()
    };
    chat.global.push(msg);
    if (chat.global.length > 100) chat.global = chat.global.slice(-100);
    saveChat(chat);
    res.json({ success: true, message: msg });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: 'server error' });
  }
});

/** Личная переписка */
app.get('/api/chat/pm/:userId/:otherId', (req, res) => {
  try {
    const a = String(req.params.userId || '');
    const b = String(req.params.otherId || '');
    const pms = loadPMs();
    const key = pmKey(a, b);
    const msgs = (pms[key] || []).slice(-50);
    res.json({ success: true, messages: msgs });
  } catch (e) {
    res.json({ success: true, messages: [] });
  }
});

app.post('/api/chat/pm', (req, res) => {
  try {
    const fromId = String(req.body?.fromId || '').trim();
    const toId = String(req.body?.toId || '').trim();
    const text = String(req.body?.text || '').trim().slice(0, 200);
    if (!fromId || !toId || !text) return res.status(400).json({ success: false, error: 'empty' });
    if (fromId === toId) return res.status(400).json({ success: false, error: 'self' });

    const players = loadPlayers();
    const me = players[fromId];
    const other = players[toId];
    if (!me) return res.status(403).json({ success: false, error: 'Сначала зарегистрируйся' });
    if (!other) return res.status(404).json({ success: false, error: 'Игрок не найден' });

    me.lastActive = Date.now();
    players[fromId] = me;
    savePlayers(players);

    const pms = loadPMs();
    const key = pmKey(fromId, toId);
    if (!Array.isArray(pms[key])) pms[key] = [];
    const msg = {
      id: 'pm_' + Date.now(),
      from: fromId,
      name: String(me.name || 'Игрок').slice(0, 24),
      to: toId,
      text,
      time: Date.now()
    };
    pms[key].push(msg);
    if (pms[key].length > 80) pms[key] = pms[key].slice(-80);
    savePMs(pms);
    res.json({ success: true, message: msg });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: 'server error' });
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
