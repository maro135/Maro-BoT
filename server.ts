import express from 'express';
console.log('--- SERVER STARTING ---');
import { createServer as createViteServer } from 'vite';
import { Server } from 'socket.io';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore,
    Browsers,
    downloadContentFromMessage
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { JSONFilePreset } from 'lowdb/node';
import fs from 'fs';
import sharp from 'sharp';
import gTTS from 'gtts';
import { GoogleGenAI } from "@google/genai";
import { questions } from './questions.ts';
import { duaas } from './duaas.ts';
import { wisdoms } from './wisdoms.ts';
import { lovePosts } from './lovePosts.ts';
import { jokes } from './jokes.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database setup
const defaultData = { 
    users: {} as Record<string, { points: number, warnings: number, banned: boolean }>,
    groups: {} as Record<string, { enabled: boolean }>,
    logs: [] as string[],
    settings: { ownerNumber: process.env.OWNER_NUMBER || '201094534865' }
};
const db = await JSONFilePreset('db.json', defaultData);

if (!db.data.settings) {
    db.data.settings = { ownerNumber: process.env.OWNER_NUMBER || '201094534865' };
    await db.write();
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

const PORT = 3000;
const app = express();
const server = http.createServer(app);

let io: Server;

const OWNER_NUMBER = process.env.OWNER_NUMBER || '201094534865';
const DEV_CHANNEL = 'https://whatsapp.com/channel/0029VbANEgU4NVipdhsRvO0f';

const channelContext = {
    contextInfo: {
        externalAdReply: {
            title: "🤖 قناة مطور البوت",
            body: "اضغط هنا للانضمام ومتابعة التحديثات",
            thumbnailUrl: "https://i.imgur.com/M1Bw2b9.jpeg", // Bot avatar image
            sourceUrl: DEV_CHANNEL
        }
    }
};

let sock: any = null;
let isStarting = false;
let stopBotFlag = false;
let reconnectionCount = 0;
let pairingCode: string | null = null;
let botStatus: 'connected' | 'disconnected' | 'connecting' = 'disconnected';
let reconnectTimeout: NodeJS.Timeout | null = null;
const installState: Record<string, boolean> = {};
const questionState: Record<string, { answer: string, sender: string }> = {};
const tttState: Record<string, {
    playerX: string;
    playerO: string | null;
    board: string[];
    turn: 'X' | 'O';
}> = {};

async function sendTTTBoard(from: string, sock: any, game: any, extraText: string = '', mentions: string[] = []) {
    const b = game.board;
    const boardText = `
${b[0]} | ${b[1]} | ${b[2]}
───┼───┼───
${b[3]} | ${b[4]} | ${b[5]}
───┼───┼───
${b[6]} | ${b[7]} | ${b[8]}
`;
    let text = `🎮 *لعبة إكس أو (X-O)*\n\n❌ اللاعب الأول: @${game.playerX.split('@')[0]}\n⭕ اللاعب الثاني: @${game.playerO ? game.playerO.split('@')[0] : 'في الانتظار...'}\n\n${boardText}\n`;
    
    if (extraText) {
        text += `\n${extraText}`;
    } else if (game.playerO) {
        const currentPlayer = game.turn === 'X' ? game.playerX : game.playerO;
        text += `\nدور اللاعب: @${currentPlayer.split('@')[0]} (${game.turn === 'X' ? '❌' : '⭕'})\nأرسل رقم المربع (1-9) للعب.`;
        mentions.push(currentPlayer);
    }
    
    const uniqueMentions = [...new Set([...mentions, game.playerX, game.playerO].filter(Boolean))];
    await sock.sendMessage(from, { text, mentions: uniqueMentions });
}

function addLog(message: string) {
    const log = `[${new Date().toLocaleTimeString()}] ${message}`;
    console.log(log);
    if (db.data) {
        db.data.logs.push(log);
        if (db.data.logs.length > 100) db.data.logs.shift();
        db.write().catch(err => console.error('DB Write Error:', err));
    }
    if (io) io.emit('log', log);
}

async function sendUsage(from: string, msg: any, usage: string, description: string) {
    await sock.sendMessage(from, { 
        text: `❌ *خطأ في استخدام الأمر*\n\n*الوصف:* ${description}\n*الاستخدام الصحيح:* \`${usage}\``,
        reply: msg
    });
}

async function sendStats() {
    let activeBots = 0;
    try {
        const files = fs.readdirSync('.');
        for (const file of files) {
            if (file.startsWith('session_') && fs.existsSync(path.join(file, 'creds.json'))) {
                activeBots++;
            }
        }
    } catch (err) {
        console.error('Error reading sessions:', err);
    }

    const stats = {
        groups: Object.keys(db.data.groups).length,
        users: Object.keys(db.data.users).length,
        activeBots: activeBots
    };
    io.emit('stats', stats);
    io.emit('bannedUsers', db.data.users);
}

async function handleInstallation(phoneNumber: string, from: string, sender: string) {
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    
    if (cleanNumber.length < 10) {
        await sock.sendMessage(from, { text: '❌ رقم الهاتف غير صحيح. تأكد من كتابته بالصيغة الدولية (مثال: 201094534865)' });
        return;
    }
    
    delete installState[sender];
    await sock.sendMessage(from, { text: '⏳ جاري بدء عملية التنصيب وطلب الكود من واتساب ويب... انتظر قليلاً' });
    
    const tempDir = `session_${cleanNumber}`;
    try {
        // Ensure a fresh start for this number
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });

        const { state, saveCreds } = await useMultiFileAuthState(tempDir);
        const { version } = await fetchLatestBaileysVersion();
        
        // Create a real socket just like the main bot
        const tempSock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            browser: Browsers.ubuntu('Chrome'),
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
        });

        tempSock.ev.on('creds.update', saveCreds);
        
        let hasSentConnectedMessage = false;
        // Monitor connection for the sub-bot to ensure it stays alive after pairing
        tempSock.ev.on('connection.update', async (update: any) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                addLog(`[Sub-Bot] ✅ Number ${cleanNumber} connected successfully!`);
                if (!hasSentConnectedMessage) {
                    hasSentConnectedMessage = true;
                    await sock.sendMessage(from, { text: `✅ *تم ربط الرقم ${cleanNumber} بنجاح!* البوت الفرعي يعمل الآن.` });
                }
            }
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    addLog(`[Sub-Bot] Reconnecting sub-bot ${cleanNumber}...`);
                    // Logic to restart sub-bot could be added here
                }
            }
        });

        // Robust Pairing Code Request with retries
        const requestPairing = async (retries = 5) => {
            try {
                addLog(`[Sub-Bot] Requesting code for ${cleanNumber} (Attempt ${6 - retries}/5)`);
                // Wait for socket to be fully initialized
                await new Promise(resolve => setTimeout(resolve, 10000));
                
                const code = await tempSock.requestPairingCode(cleanNumber);
                if (code) {
                    await sock.sendMessage(from, { 
                        text: `✅ *كود الربط الحقيقي الخاص بك هو:*\n\n` +
                              `*${code}*\n\n` +
                              `قم بإدخال هذا الكود في واتساب (الأجهزة المرتبطة > ربط جهاز > الربط برقم الهاتف).\n\n` +
                              `⚠️ الكود صالح لمدة دقيقتين فقط.`,
                        ...channelContext
                    });
                    addLog(`[Sub-Bot] ✅ Code ${code} sent to user for ${cleanNumber}`);
                }
            } catch (err: any) {
                addLog(`[Sub-Bot] ⚠️ Request failed: ${err.message}`);
                if (retries > 0) {
                    addLog(`[Sub-Bot] Retrying in 7 seconds...`);
                    setTimeout(() => requestPairing(retries - 1), 7000);
                } else {
                    await sock.sendMessage(from, { text: `❌ فشل طلب الكود بعد عدة محاولات. تأكد من أن الرقم صحيح وحاول مجدداً لاحقاً.` });
                }
            }
        };

        requestPairing();

    } catch (err: any) {
        addLog(`[Sub-Bot] ❌ Fatal error: ${err.message}`);
        await sock.sendMessage(from, { text: `❌ حدث خطأ أثناء التنصيب: ${err.message}` });
    }
}

async function startBot(phoneNumber?: string, clearSession: boolean = false) {
    if (stopBotFlag) return;
    
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    if (isStarting) {
        addLog('[System] Bot is already starting, skipping...');
        return;
    }
    isStarting = true;

    try {
        if (sock) {
            try {
                sock.ev.removeAllListeners();
                sock.end(undefined);
            } catch (e) {}
            sock = null;
        }

        // Sanitize input number
        const cleanNumber = phoneNumber ? phoneNumber.replace(/[^0-9]/g, '') : undefined;

        // Use a dynamic session folder based on the phone number
        const sessionFolder = cleanNumber ? `session_${cleanNumber}` : 'session_default';

        // ONLY clear old session if explicitly requested
        if (clearSession && fs.existsSync(sessionFolder)) {
            addLog(`[System] Clearing old session to ensure fresh pairing for ${cleanNumber || 'default'}...`);
            fs.rmSync(sessionFolder, { recursive: true, force: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            browser: Browsers.ubuntu('Chrome'),
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            getMessage: async (key) => {
                return { conversation: 'hello' };
            }
        });

        botStatus = 'connecting';
        io.emit('status', botStatus);

        // Handle Pairing Code Request for Main Bot
        if (cleanNumber && !state.creds.registered) {
            addLog(`[WhatsApp] Connecting to servers to request code for ${cleanNumber}...`);
            
            const requestPairing = async (retries = 3) => {
                try {
                    if (!sock || botStatus === 'disconnected') return;
                    
                    addLog(`[WhatsApp] Requesting pairing code for number: ${cleanNumber}... (Attempt ${4 - retries}/3)`);
                    pairingCode = await sock.requestPairingCode(cleanNumber);
                    
                    if (pairingCode) {
                        addLog(`[WhatsApp] ✅ Pairing Code received: ${pairingCode}`);
                        io.emit('pairingCode', pairingCode);
                    }
                } catch (err: any) {
                    addLog(`[WhatsApp] ⚠️ Attempt failed: ${err.message}`);
                    if (retries > 0) {
                        addLog(`[WhatsApp] Retrying in 3 seconds...`);
                        setTimeout(() => requestPairing(retries - 1), 3000);
                    } else {
                        addLog(`[WhatsApp] ❌ Failed to get code after all retries.`);
                        botStatus = 'disconnected';
                        io.emit('status', botStatus);
                        io.emit('pairingCode', null);
                    }
                }
            };

            // Wait for socket to be ready
            setTimeout(() => requestPairing(), 3000);
        } else if (cleanNumber && state.creds.registered) {
            addLog(`[WhatsApp] ⚠️ This device is already registered. Attempting to connect...`);
        }

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update: any) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'close') {
                const error = lastDisconnect?.error as any;
                const statusCode = error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                botStatus = 'disconnected';
                io.emit('status', botStatus);
                addLog(`Connection closed. Error: ${error?.message || 'No error message'}. Status Code: ${statusCode || 'No status code'}. Reconnecting: ${shouldReconnect}`);
                
                if (shouldReconnect && !stopBotFlag) {
                    reconnectionCount++;
                    if (reconnectionCount > 5) {
                        addLog(`[System] Too many reconnection attempts. Stopping bot.`);
                        stopBotFlag = true;
                        return;
                    }

                    // Reset socket to prevent memory leaks before reconnecting
                    if (sock) {
                        try {
                            sock.ev.removeAllListeners();
                            sock.end(undefined);
                        } catch (e) {}
                        sock = null;
                    }
                    
                    // Handle Conflict (440) specifically
                    let delay = 10000;
                    if (statusCode === 440) {
                        addLog(`[System] Conflict detected (440). Clearing session and waiting longer.`);
                        if (fs.existsSync(sessionFolder)) {
                            fs.rmSync(sessionFolder, { recursive: true, force: true });
                        }
                        delay = 30000; // Wait 30 seconds for conflict resolution
                    }
                    
                    // Prevent rapid reconnects
                    if (reconnectTimeout) clearTimeout(reconnectTimeout);
                    addLog(`[System] Attempting reconnection (${reconnectionCount}/5) in ${delay / 1000} seconds...`);
                    reconnectTimeout = setTimeout(() => {
                        isStarting = false;
                        startBot(cleanNumber, false);
                    }, delay);
                } else if (statusCode === DisconnectReason.loggedOut) {
                    stopBotFlag = true;
                    addLog('Logged out. Please restart and pair again.');
                    if (fs.existsSync(sessionFolder)) {
                        fs.rmSync(sessionFolder, { recursive: true, force: true });
                    }
                } else {
                    stopBotFlag = true;
                    addLog('Connection failed completely. Please restart.');
                }
            } else if (connection === 'open') {
                botStatus = 'connected';
                reconnectionCount = 0; // Reset counter on successful connection
                io.emit('status', botStatus);
                pairingCode = null;
                io.emit('pairingCode', null);
                addLog('Maro BOT connected to WhatsApp!');
            }
        });

        sock.ev.on('messages.upsert', async (m: any) => {
        try {
            const msg = m.messages[0];
            if (!msg.message) return;
            
            const from = msg.key.remoteJid;
            const sender = msg.key.participant || from;
            const pushName = msg.pushName || 'User';
            const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            
            // Allow commands from the bot itself (if the user is testing using "Message Yourself")
            if (msg.key.fromMe && !body.startsWith('.')) return;

            const isGroup = from.endsWith('@g.us');
            const args = body.trim().split(/ +/).slice(1);
            const command = body.trim().split(/ +/)[0].toLowerCase();
            
            const botNumber = sock.user?.id?.split(':')[0];
            const currentOwner = db.data.settings?.ownerNumber || OWNER_NUMBER;
            
            // If the message is from the bot's own phone (fromMe), the sender is effectively the owner/bot.
            const isOwner = msg.key.fromMe || sender.includes(currentOwner) || (botNumber && sender.includes(botNumber));

            // Debug logging for owner commands
            if (['.حظر', '.فك_حظر', '.تفعيل', '.تعطيل'].includes(command)) {
                addLog(`[Debug] Owner Command Check - Sender: ${sender}, fromMe: ${msg.key.fromMe}, isOwner: ${isOwner}`);
            }

            // Initialize user in DB
            if (!db.data.users[sender]) {
                db.data.users[sender] = { points: 0, warnings: 0, banned: false };
                await db.write();
            }

            const userData = db.data.users[sender];

            // Handle Question Answers
            if (questionState[from] && !body.startsWith('.')) {
                const state = questionState[from];
                if (state.sender === sender) {
                    if (body.trim().toLowerCase() === state.answer.toLowerCase()) {
                        delete questionState[from];
                        userData.points += 10;
                        await db.write();
                        await sock.sendMessage(from, { 
                            text: `✅ *إجابة صحيحة يا ${pushName}!*\n\nلقد حصلت على 10 نقاط. رصيدك الحالي هو: ${userData.points} نقطة. ✨`,
                            reply: msg
                        });
                    }
                }
            }

            // Handle Tic-Tac-Toe Moves
            if (tttState[from] && tttState[from].playerO && /^[1-9]$/.test(body.trim())) {
                const game = tttState[from];
                const currentPlayer = game.turn === 'X' ? game.playerX : game.playerO;
                
                if (sender === currentPlayer) {
                    const move = parseInt(body.trim()) - 1;
                    if (game.board[move] === '❌' || game.board[move] === '⭕') {
                        await sock.sendMessage(from, { text: '❌ هذا المربع ممتلئ، اختر مربعاً آخر.', reply: msg });
                        return;
                    }

                    game.board[move] = game.turn === 'X' ? '❌' : '⭕';
                    
                    const winPatterns = [
                        [0, 1, 2], [3, 4, 5], [6, 7, 8],
                        [0, 3, 6], [1, 4, 7], [2, 5, 8],
                        [0, 4, 8], [2, 4, 6]
                    ];

                    let winner = null;
                    for (const pattern of winPatterns) {
                        const [a, b, c] = pattern;
                        if (game.board[a] === game.board[b] && game.board[b] === game.board[c] && (game.board[a] === '❌' || game.board[a] === '⭕')) {
                            winner = game.turn;
                            break;
                        }
                    }

                    if (winner) {
                        const winnerId = winner === 'X' ? game.playerX : game.playerO;
                        const loserId = winner === 'X' ? game.playerO : game.playerX;
                        
                        db.data.users[winnerId].points += 50;
                        await db.write();

                        await sendTTTBoard(from, sock, game, `🎉 *انتهت اللعبة!*\n\nالفائز هو: @${winnerId.split('@')[0]} (حصل على 50 نقطة 💰)\nحظ أوفر لـ @${loserId.split('@')[0]}`, [winnerId, loserId]);
                        delete tttState[from];
                    } else if (game.board.every(cell => cell === '❌' || cell === '⭕')) {
                        await sendTTTBoard(from, sock, game, `🤝 *انتهت اللعبة بالتعادل!*\n\nلا يوجد فائز هذه المرة.`);
                        delete tttState[from];
                    } else {
                        game.turn = game.turn === 'X' ? 'O' : 'X';
                        await sendTTTBoard(from, sock, game);
                    }
                    return;
                }
            }

            // Handle Installation Flow (Pairing Request via Chat)
            if (installState[sender] && !body.startsWith('.')) {
                const phoneNumber = body.trim().replace(/[^0-9]/g, '');
                await handleInstallation(phoneNumber, from, sender);
                return;
            }

            // Check if banned
            if (userData.banned && !isOwner && command !== '.unban' && command !== '.فك_حظر') return;

            // Anti-link system
            if (isGroup && body.match(/https?:\/\/[^\s]+|wa\.me\/[^\s]+/gi)) {
                const groupData = db.data.groups[from];
                if (groupData?.enabled) {
                    const groupMetadata = await sock.groupMetadata(from);
                    const isAdmin = groupMetadata.participants.find((p: any) => p.id === sender)?.admin || isOwner;
                    
                    if (!isAdmin) {
                        await sock.sendMessage(from, { delete: msg.key });
                        userData.warnings++;
                        await db.write();
                        
                        if (userData.warnings >= 3) {
                            await sock.sendMessage(from, { text: `تم طرد @${sender.split('@')[0]} بسبب إرسال الروابط المتكرر.`, mentions: [sender] });
                            await sock.groupParticipantsUpdate(from, [sender], 'remove');
                            userData.warnings = 0;
                            await db.write();
                        } else {
                            await sock.sendMessage(from, { text: `⚠️ تحذير @${sender.split('@')[0]}: الروابط ممنوعة! لديك ${userData.warnings}/3 تحذيرات.`, mentions: [sender] });
                        }
                        return;
                    }
                }
            }

            // Helper function to check owner permission
            const checkOwner = async () => {
                if (!isOwner) {
                    const senderId = sender.split('@')[0];
                    await sock.sendMessage(from, { 
                        text: `❌ *عذراً، هذا الأمر مخصص لمالك البوت فقط.*\n\nرقم المالك المسجل حالياً هو: ${currentOwner}\n\n⚠️ *ملاحظة هامة:* يبدو أن واتساب يقرأ معرفك بهذا الشكل: \`${senderId}\`\n\nإذا كنت أنت المالك، يرجى نسخ هذا الرقم 👆 ووضعه في خانة "رقم المالك" في لوحة التحكم ثم اضغط حفظ.`, 
                        reply: msg 
                    });
                    return false;
                }
                return true;
            };

            // Command handling
            switch (command) {
                case '.menu':
                case '.اوامر':
                    const menu = `╭───〔 🤖 *بـوت مـارو* 〕───╮\n` +
                        `┆\n` +
                        `├─〔 *👤 أوامر المستخدم* 〕\n` +
                        `┆ ▫️ .نقاطي ↫ عرض رصيدك\n` +
                        `┆ ▫️ .سؤال ↫ مسابقة (10 نقاط)\n` +
                        `┆ ▫️ .دعاء ↫ أدعية إسلامية\n` +
                        `┆ ▫️ .حكمة ↫ حكمة عشوائية\n` +
                        `┆ ▫️ .حب ↫ بوست حب عشوائي\n` +
                        `┆ ▫️ .نكتة ↫ نكتة مصرية مضحكة\n` +
                        `┆ ▫️ .قول ↫ تحويل نص لصوت\n` +
                        `┆ ▫️ .لصورة ↫ ملصق ➔ صورة\n` +
                        `┆ ▫️ .بروفايل ↫ صورة الحساب\n` +
                        `┆ ▫️ .زواج ↫ اختيار زوجين\n` +
                        `┆ ▫️ .طلاق ↫ تفريق زوجين\n` +
                        `┆ ▫️ .اكس ↫ لعبة إكس أو\n` +
                        `┆ ▫️ .توب ↫ قائمة عشوائية\n` +
                        `┆ ▫️ .تنصيب ↫ ربط رقمك\n` +
                        `┆ ▫️ .تهكير ↫ مقلب الاختراق\n` +
                        `┆ ▫️ .المطور ↫ رقم المطور\n` +
                        `┆\n` +
                        `├─〔 *🛡️ أوامر المشرفين* 〕\n` +
                        `┆ ▫️ .قفل ↫ إغلاق الشات\n` +
                        `┆ ▫️ .فتح ↫ فتح الشات\n` +
                        `┆ ▫️ .مكافحة ↫ منع الروابط\n` +
                        `┆ ▫️ .طرد ↫ إزالة عضو\n` +
                        `┆ ▫️ .رفع ↫ ترقية لمشرف\n` +
                        `┆ ▫️ .تنزيل ↫ سحب الإشراف\n` +
                        `┆ ▫️ .منشن ↫ نداء للكل\n` +
                        `┆ ▫️ .رابط ↫ لينك الجروب\n` +
                        `┆\n` +
                        `├─〔 *⚙️ أوامر المطور* 〕\n` +
                        `┆ ▫️ .حظر ↫ حظر مستخدم\n` +
                        `┆ ▫️ .فك_حظر ↫ إلغاء الحظر\n` +
                        `┆ ▫️ .تفعيل ↫ تشغيل البوت\n` +
                        `┆ ▫️ .تعطيل ↫ إيقاف البوت\n` +
                        `┆\n` +
                        `╰──────────────╯`;
                    await sock.sendMessage(from, { text: menu, ...channelContext });
                    break;

                case '.تهكير':
                    const target = msg.message.extendedTextMessage?.contextInfo?.participant;
                    if (!target) {
                        await sock.sendMessage(from, { text: '❌ يجب الرد على رسالة الشخص الذي تريد اختراقه', reply: msg });
                        return;
                    }

                    await sock.sendMessage(from, { text: `[!] جاري تهيئة بيئة الاختراق...\nالهدف: @${target.split('@')[0]}\nجاري تحديد عنوان الـ IP...`, mentions: [target] });
                    
                    setTimeout(async () => {
                        await sock.sendMessage(from, { text: `[+] تم تحديد الهدف بنجاح.\nجاري تخطي تشفير الواتساب (E2EE)...\n[████░░░░░░░░] 30%` });
                        
                        setTimeout(async () => {
                            await sock.sendMessage(from, { text: `[+] جاري سحب قاعدة البيانات (msgstore.db)...\nجاري فك تشفير الملفات المحلية...\n[████████░░░░] 70%` });
                            
                            setTimeout(async () => {
                                await sock.sendMessage(from, { text: `[√] تم فك التشفير بنجاح.\nتم سحب 14,502 رسالة و 342 صورة.\nجاري الرفع للخوادم الآمنة...\n[██████████░░] 90%` });
                                
                                setTimeout(async () => {
                                    await sock.sendMessage(from, { 
                                        text: `[!] اكتملت العملية 100%.\n\n✅ تم السيطرة على جهاز @${target.split('@')[0]} بالكامل.\nتم حفظ جميع البيانات في خوادم البوت.`, 
                                        mentions: [target] 
                                    });
                                }, 2500);
                            }, 2500);
                        }, 2500);
                    }, 2500);
                    break;

                case '.تنصيب':
                const num = args[0]?.replace(/[^0-9]/g, '');
                if (num && num.length >= 10) {
                    await handleInstallation(num, from, sender);
                } else if (args[0]) {
                    await sendUsage(from, msg, '.تنصيب [رقم الهاتف]', 'لربط رقم هاتف جديد بالبوت');
                } else {
                    installState[sender] = true;
                    await sock.sendMessage(from, { 
                        text: `🚀 *بدء عملية التنصيب*\n\nمن فضلك أرسل رقم الهاتف الذي تريد ربطه بالبوت بالصيغة الدولية (بدون +)\nمثال: .تنصيب 201094534865\n\nلإلغاء العملية أرسل .إلغاء` 
                    });
                }
                return;

            case '.إلغاء':
                if (installState[sender]) {
                    delete installState[sender];
                    await sock.sendMessage(from, { text: '❌ تم إلغاء عملية التنصيب.' });
                }
                break;

            case '.نقاطي':
                await sock.sendMessage(from, { text: `💰 رصيد نقاطك يا ${pushName} هو: ${userData.points}`, ...channelContext });
                break;

            case '.دعاء':
                const randomDuaa = duaas[Math.floor(Math.random() * duaas.length)];
                await sock.sendMessage(from, { text: `🤲 *دعاء:*\n\n${randomDuaa}` });
                break;

            case '.حكمة':
                const randomWisdom = wisdoms[Math.floor(Math.random() * wisdoms.length)];
                await sock.sendMessage(from, { text: `💡 *حكمة اليوم:*\n\n${randomWisdom}` });
                break;

            case '.حب':
                const randomLove = lovePosts[Math.floor(Math.random() * lovePosts.length)];
                await sock.sendMessage(from, { text: `❤️ *بوست حب:*\n\n${randomLove}` });
                break;

            case '.نكتة':
                const randomJoke = jokes[Math.floor(Math.random() * jokes.length)];
                await sock.sendMessage(from, { text: `😂 *نكتة اليوم:*\n\n${randomJoke}` });
                break;

            case '.قول':
                const textToSay = args.join(' ');
                if (!textToSay) {
                    await sendUsage(from, msg, '.قول [النص]', 'لتحويل النص إلى صوت');
                    return;
                }
                
                try {
                    const gtts = new gTTS(textToSay, 'ar');
                    const tempFile = path.join(__dirname, `temp_${Date.now()}.mp3`);
                    
                    gtts.save(tempFile, async (err: any) => {
                        if (err) {
                            addLog(`[Error] gTTS Save: ${err}`);
                            await sock.sendMessage(from, { text: '❌ فشل تحويل النص إلى صوت.' });
                            return;
                        }
                        
                        await sock.sendMessage(from, { 
                            audio: { url: tempFile }, 
                            mimetype: 'audio/mp4', 
                            ptt: true 
                        });
                        
                        // Delete temp file after sending
                        setTimeout(() => {
                            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                        }, 5000);
                    });
                } catch (err) {
                    addLog(`[Error] .قول Command: ${err}`);
                    await sock.sendMessage(from, { text: '❌ حدث خطأ أثناء معالجة الطلب.' });
                }
                break;

            case '.لصورة':
                const quotedSticker = msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.stickerMessage;
                if (!quotedSticker) {
                    await sendUsage(from, msg, '.لصورة (مع الرد على ملصق)', 'لتحويل ملصق إلى صورة');
                    return;
                }
                
                try {
                    await sock.sendMessage(from, { text: '⏳ جاري التحويل... انتظر قليلاً' });
                    
                    const stream = await downloadContentFromMessage(quotedSticker, 'sticker');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }
                    
                    const imageBuffer = await sharp(buffer)
                        .toFormat('png')
                        .toBuffer();
                    
                    await sock.sendMessage(from, { 
                        image: imageBuffer, 
                        caption: '✅ تم تحويل الملصق إلى صورة بنجاح!' 
                    });
                } catch (err) {
                    addLog(`[Error] Sticker to Image: ${err}`);
                    await sock.sendMessage(from, { text: '❌ فشل تحويل الملصق. قد يكون الملصق تالفاً أو متحركاً.' });
                }
                break;

            case '.سؤال':
                const randomQuestion = questions[Math.floor(Math.random() * questions.length)];
                questionState[from] = { answer: randomQuestion.a, sender: sender };
                await sock.sendMessage(from, { 
                    text: `❓ *سؤال للذكي @${sender.split('@')[0]} :*\n\n${randomQuestion.q}\n\nأجب على هذه الرسالة بالإجابة الصحيحة للفوز بـ 10 نقاط! 🏆`,
                    mentions: [sender]
                });
                break;

            case '.المطور':
                await sock.sendMessage(from, { 
                    text: `👨‍💻 *مطور البوت*\n\nرقم المطور: +201094534865\nللتواصل المباشر:\nwa.me/201094534865`,
                    ...channelContext
                });
                break;

            case '.اكس':
                if (!isGroup) {
                    await sock.sendMessage(from, { text: '❌ هذه اللعبة متاحة في المجموعات فقط.' });
                    return;
                }
                
                if (args[0] === 'انهاء') {
                    if (tttState[from]) {
                        delete tttState[from];
                        await sock.sendMessage(from, { text: '✅ تم إنهاء اللعبة الحالية.' });
                    } else {
                        await sock.sendMessage(from, { text: '❌ لا توجد لعبة جارية لنهائها.' });
                    }
                    return;
                }

                if (!tttState[from]) {
                    tttState[from] = {
                        playerX: sender,
                        playerO: null,
                        board: ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'],
                        turn: 'X'
                    };
                    await sock.sendMessage(from, { 
                        text: `🎮 *لعبة إكس أو (X-O)*\n\nاللاعب الأول (❌): @${sender.split('@')[0]}\nفي انتظار اللاعب الثاني (⭕)...\n\nللانضمام أرسل: .اكس`, 
                        mentions: [sender] 
                    });
                } else if (!tttState[from].playerO && tttState[from].playerX !== sender) {
                    tttState[from].playerO = sender;
                    await sendTTTBoard(from, sock, tttState[from]);
                } else if (tttState[from].playerO) {
                    await sock.sendMessage(from, { text: '❌ هناك لعبة جارية بالفعل في هذه المجموعة. لإنهاء اللعبة أرسل: .اكس انهاء' });
                }
                break;

            case '.زواج':
                if (!isGroup) return;
                const metadata = await sock.groupMetadata(from);
                const participants = metadata.participants;
                let user1 = participants[Math.floor(Math.random() * participants.length)].id;
                let user2 = participants[Math.floor(Math.random() * participants.length)].id;
                
                // Ensure they are not the same person
                while (user1 === user2 && participants.length > 1) {
                    user2 = participants[Math.floor(Math.random() * participants.length)].id;
                }

                const marriagePhrases = [
                    `💍 *تم الزواج!*\nألف مبروك للعريس @${user1.split('@')[0]} والعروسة @${user2.split('@')[0]} 🎉\nأخيراً لقينا حد يلمكم 😂`,
                    `💍 *إعلان زواج!*\nتم تدبيس @${user1.split('@')[0]} في @${user2.split('@')[0]} 💔\nربنا يعينكم على البلوة دي 🏃‍♂️`,
                    `💍 *زواج سعيد!*\nمبروك لـ @${user1.split('@')[0]} و @${user2.split('@')[0]} ✨\nعقبال البكاري، مع إني أشك إنكم هتعمروا 🤣`,
                    `💍 *زواج الموسم!*\nيا بخت من وفق راسين في الحلال، مبروك @${user1.split('@')[0]} و @${user2.split('@')[0]} 🎊\nولو إن الراسين دول محتاجين كشف قوى عقلية 🧠`,
                    `💍 *تمت الجريمة بنجاح!*\nالبقاء لله في حريتكم يا @${user1.split('@')[0]} و @${user2.split('@')[0]} 🕊️😂`
                ];
                
                const randomMarriage = marriagePhrases[Math.floor(Math.random() * marriagePhrases.length)];
                await sock.sendMessage(from, { text: randomMarriage, mentions: [user1, user2] });
                break;

            case '.طلاق':
                if (!isGroup) return;
                const metadataDivorce = await sock.groupMetadata(from);
                const participantsDivorce = metadataDivorce.participants;
                let divUser1 = participantsDivorce[Math.floor(Math.random() * participantsDivorce.length)].id;
                let divUser2 = participantsDivorce[Math.floor(Math.random() * participantsDivorce.length)].id;
                
                while (divUser1 === divUser2 && participantsDivorce.length > 1) {
                    divUser2 = participantsDivorce[Math.floor(Math.random() * participantsDivorce.length)].id;
                }

                const divorcePhrases = [
                    `💔 *تم الطلاق!*\nأحسن قرار أخدتوه في حياتكم، مبروك الحرية لـ @${divUser1.split('@')[0]} و @${divUser2.split('@')[0]} 🦅😂`,
                    `💔 *إعلان انفصال!*\nيا ساتر، أخيراً فكينا الارتباط المنيل بين @${divUser1.split('@')[0]} و @${divUser2.split('@')[0]} ✂️🏃‍♂️`,
                    `💔 *فركش!*\nكل واحد يروح لحاله ومحدش يزعل التاني بقى يا @${divUser1.split('@')[0]} ويا @${divUser2.split('@')[0]} 🚶‍♂️🚶‍♀️`,
                    `💔 *تم الانفصال!*\nيلا كل واحد يدور على ضحية جديدة 😈\nمبروك @${divUser1.split('@')[0]} و @${divUser2.split('@')[0]}`,
                    `💔 *محكمة!*\nتم الانفصال بنجاح بين @${divUser1.split('@')[0]} و @${divUser2.split('@')[0]} ⚖️\nالعفش على مين بقى؟ 🛋️😂`
                ];
                
                const randomDivorce = divorcePhrases[Math.floor(Math.random() * divorcePhrases.length)];
                await sock.sendMessage(from, { text: randomDivorce, mentions: [divUser1, divUser2] });
                break;

            case '.توب':
                if (!isGroup) return;
                const category = args[0] || 'المميزين';
                let count = parseInt(args[1]) || 5;
                if (count > 20) count = 20;
                
                const groupMetadataTop = await sock.groupMetadata(from);
                const allParticipants = groupMetadataTop.participants;
                
                // Shuffle and pick
                const shuffled = allParticipants.sort(() => 0.5 - Math.random());
                const selected = shuffled.slice(0, Math.min(count, allParticipants.length));
                
                let topText = `🏆 *قائمة توب ${count} ${category} في المجموعة:*\n\n`;
                const mentions = [];
                
                selected.forEach((p: any, i: number) => {
                    topText += `${i + 1} - @${p.id.split('@')[0]}\n`;
                    mentions.push(p.id);
                });
                
                topText += `\n✨ *مبروك للفائزين!*`;
                await sock.sendMessage(from, { text: topText, mentions });
                break;

            case '.بروفايل':
                const quotedProfile = msg.message.extendedTextMessage?.contextInfo?.participant;
                if (!quotedProfile) {
                    await sock.sendMessage(from, { text: '❌ من فضلك قم بالرد على رسالة الشخص الذي تريد رؤية صورته.' });
                    return;
                }
                try {
                    const ppUrl = await sock.profilePictureUrl(quotedProfile, 'image');
                    await sock.sendMessage(from, { 
                        image: { url: ppUrl }, 
                        caption: `👤 صورة الملف الشخصي لـ @${quotedProfile.split('@')[0]}`,
                        mentions: [quotedProfile]
                    });
                } catch (err) {
                    await sock.sendMessage(from, { text: '❌ لا توجد صورة ملف شخصي متاحة أو أن المستخدم قام بإخفائها.' });
                }
                break;

            // Admin Commands
            case '.قفل':
                if (!isGroup) return;
                const groupMetaLock = await sock.groupMetadata(from);
                if (groupMetaLock.participants.find((p: any) => p.id === sender)?.admin || isOwner) {
                    await sock.groupSettingUpdate(from, 'announcement');
                    await sock.sendMessage(from, { text: '🔒 تم إغلاق المجموعة (للمشرفين فقط)' });
                }
                break;

            case '.فتح':
                if (!isGroup) return;
                const groupMetaOpen = await sock.groupMetadata(from);
                if (groupMetaOpen.participants.find((p: any) => p.id === sender)?.admin || isOwner) {
                    await sock.groupSettingUpdate(from, 'not_announcement');
                    await sock.sendMessage(from, { text: '🔓 تم فتح المجموعة (للجميع)' });
                }
                break;

            case '.طرد':
                if (!isGroup) return;
                const groupMetaKick = await sock.groupMetadata(from);
                if (groupMetaKick.participants.find((p: any) => p.id === sender)?.admin || isOwner) {
                    let target = msg.message.extendedTextMessage?.contextInfo?.participant || 
                                 (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0]) ||
                                 (args[0]?.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
                    
                    if (target && target.length > 15) {
                        await sock.groupParticipantsUpdate(from, [target], 'remove');
                        await sock.sendMessage(from, { text: '✅ تم طرد العضو بنجاح' });
                    } else {
                        await sendUsage(from, msg, '.طرد [منشن/رد]', 'لطرد عضو من المجموعة');
                    }
                }
                break;

            case '.رفع':
                if (!isGroup) return;
                const groupMetaPromote = await sock.groupMetadata(from);
                if (groupMetaPromote.participants.find((p: any) => p.id === sender)?.admin || isOwner) {
                    let target = msg.message.extendedTextMessage?.contextInfo?.participant || 
                                 (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0]) ||
                                 (args[0]?.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
                    
                    if (target && target.length > 15) {
                        await sock.groupParticipantsUpdate(from, [target], 'promote');
                        await sock.sendMessage(from, { text: '✅ تم رفع العضو لمشرف' });
                    } else {
                        await sendUsage(from, msg, '.رفع [منشن/رد]', 'لترقية عضو إلى مشرف');
                    }
                }
                break;

            case '.تنزيل':
                if (!isGroup) return;
                const groupMetaDemote = await sock.groupMetadata(from);
                if (groupMetaDemote.participants.find((p: any) => p.id === sender)?.admin || isOwner) {
                    let target = msg.message.extendedTextMessage?.contextInfo?.participant || 
                                 (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0]) ||
                                 (args[0]?.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
                    
                    if (target && target.length > 15) {
                        await sock.groupParticipantsUpdate(from, [target], 'demote');
                        await sock.sendMessage(from, { text: '✅ تم إنزال المشرف لعضو' });
                    } else {
                        await sendUsage(from, msg, '.تنزيل [منشن/رد]', 'لسحب الإشراف من عضو');
                    }
                }
                break;

            case '.منشن':
                if (!isGroup) return;
                const groupMetaMention = await sock.groupMetadata(from);
                if (groupMetaMention.participants.find((p: any) => p.id === sender)?.admin || isOwner) {
                    const participants = groupMetaMention.participants.map((p: any) => p.id);
                    let text = `📢 *نداء للجميع:*\n\n`;
                    for (let mem of participants) {
                        text += `@${mem.split('@')[0]} `;
                    }
                    await sock.sendMessage(from, { text, mentions: participants, ...channelContext });
                }
                break;

            case '.رابط':
                if (!isGroup) return;
                const code = await sock.groupInviteCode(from);
                await sock.sendMessage(from, { text: `🔗 رابط المجموعة:\nhttps://chat.whatsapp.com/${code}` });
                break;

            case '.مكافحة':
                if (!isGroup) return;
                const groupMetaAnti = await sock.groupMetadata(from);
                const isAdminAnti = groupMetaAnti.participants.find((p: any) => p.id === sender)?.admin || isOwner;
                
                if (isAdminAnti) {
                    if (!db.data.groups[from]) db.data.groups[from] = { enabled: false };
                    const newState = !db.data.groups[from].enabled;
                    db.data.groups[from].enabled = newState;
                    await db.write();
                    await sock.sendMessage(from, { 
                        text: `🛡️ *نظام مكافحة الروابط:*\n\nتم ${newState ? 'تفعيل ✅' : 'تعطيل ❌'} النظام في هذه المجموعة.` 
                    });
                }
                break;

            // Developer Commands
            case '.حظر':
                if (await checkOwner()) {
                    const target = args[0]?.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    if (target && args[0]) {
                        if (!db.data.users[target]) db.data.users[target] = { points: 0, warnings: 0, banned: true };
                        db.data.users[target].banned = true;
                        await db.write();
                        await sock.sendMessage(from, { text: `✅ تم حظر المستخدم ${args[0]}` });
                    } else {
                        await sendUsage(from, msg, '.حظر [رقم المستخدم]', 'لحظر مستخدم من استخدام البوت');
                    }
                }
                break;

            case '.فك_حظر':
                if (await checkOwner()) {
                    const target = args[0]?.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    if (target && args[0]) {
                        if (db.data.users[target]) {
                            db.data.users[target].banned = false;
                            await db.write();
                            await sock.sendMessage(from, { text: `✅ تم فك حظر المستخدم ${args[0]}` });
                        }
                    } else {
                        await sendUsage(from, msg, '.فك_حظر [رقم المستخدم]', 'لإلغاء حظر مستخدم');
                    }
                }
                break;

            case '.تفعيل':
                if (await checkOwner()) {
                    if (isGroup) {
                        db.data.groups[from] = { enabled: true };
                        await db.write();
                        await sock.sendMessage(from, { text: '✅ تم تفعيل حماية البوت في هذه المجموعة' });
                    } else {
                        await sendUsage(from, msg, '.تفعيل', 'يجب استخدام هذا الأمر داخل مجموعة');
                    }
                }
                break;

            case '.تعطيل':
                if (await checkOwner()) {
                    if (isGroup) {
                        db.data.groups[from] = { enabled: false };
                        await db.write();
                        await sock.sendMessage(from, { text: '❌ تم تعطيل حماية البوت في هذه المجموعة' });
                    } else {
                        await sendUsage(from, msg, '.تعطيل', 'يجب استخدام هذا الأمر داخل مجموعة');
                    }
                }
                break;
        }

        // Add points for every message
        userData.points += 1;
        await db.write();
        sendStats();
    } catch (err) {
        addLog(`[Error] messages.upsert: ${err}`);
    }
});
    } catch (err: any) {
        addLog(`[System] ❌ startBot error: ${err.message}`);
        botStatus = 'disconnected';
        io.emit('status', botStatus);
    } finally {
        isStarting = false;
    }
}

// Vite middleware
async function initServer() {
    // Initialize Socket.io early
    io = new Server(server);

    addLog(`Initializing server in ${process.env.NODE_ENV || 'development'} mode`);
    
    if (process.env.NODE_ENV !== 'production') {
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: 'spa',
        });
        app.use(vite.middlewares);
    } else {
        const distPath = path.join(process.cwd(), 'dist');
        app.use(express.static(distPath));
        app.get('*', (req, res) => {
            res.sendFile(path.join(distPath, 'index.html'));
        });
    }

    server.listen(PORT, '0.0.0.0', () => {
        addLog(`Server running on http://localhost:${PORT}`);
        
        // Auto-start if a bot number is saved and its session exists
        const savedBotNumber = db.data.settings?.botNumber;
        if (savedBotNumber) {
            const sessionFolder = `session_${savedBotNumber}`;
            if (fs.existsSync(path.join(sessionFolder, 'creds.json'))) {
                addLog(`[System] Found existing session for ${savedBotNumber}, auto-starting...`);
                startBot(savedBotNumber, false);
            }
        }
    });

    // Socket.io events
    io.on('connection', (socket) => {
        socket.emit('status', botStatus);
        socket.emit('pairingCode', pairingCode);
        socket.emit('logs', db.data.logs);
        socket.emit('ownerNumber', db.data.settings?.ownerNumber || OWNER_NUMBER);
        socket.emit('botNumber', db.data.settings?.botNumber || '');
        sendStats();

        socket.on('startBot', async (phoneNumber: string) => {
            if (botStatus === 'connected') return;
            
            stopBotFlag = false;
            addLog(`Starting bot for number: ${phoneNumber}`);
            
            // Save the last used bot number for auto-start
            const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
            if (cleanNumber && db.data.settings.botNumber !== cleanNumber) {
                db.data.settings.botNumber = cleanNumber;
                await db.write();
            }
            
            await startBot(phoneNumber, false); // Do not clear session by default
        });

        socket.on('forcePairing', async (phoneNumber: string) => {
            if (botStatus === 'connected') {
                sock?.end();
            }
            stopBotFlag = false;
            addLog(`Forcing new pairing for number: ${phoneNumber}`);
            
            const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
            if (cleanNumber) {
                db.data.settings.botNumber = cleanNumber;
                await db.write();
            }
            
            await startBot(phoneNumber, true); // Clear session to force pairing
        });

        socket.on('stopBot', () => {
            if (sock) {
                stopBotFlag = true;
                sock.end();
                botStatus = 'disconnected';
                io.emit('status', botStatus);
                addLog('Bot stopped manually.');
            }
        });

        socket.on('restartBot', () => {
            if (sock) sock.end();
            startBot();
            addLog('Bot restarting...');
        });

        socket.on('unbanUser', async (userId: string) => {
            if (db.data.users[userId]) {
                db.data.users[userId].banned = false;
                await db.write();
                addLog(`User ${userId} unbanned via panel.`);
                sendStats();
            }
        });

        socket.on('setOwnerNumber', async (number: string) => {
            const cleanNumber = number.replace(/[^0-9]/g, '');
            if (cleanNumber) {
                db.data.settings.ownerNumber = cleanNumber;
                await db.write();
                addLog(`Owner number updated to: ${cleanNumber}`);
                io.emit('ownerNumber', cleanNumber);
            }
        });
    });
}

initServer();
