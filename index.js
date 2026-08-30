const pino = require("pino");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
require('./config');

// Load blocked chats globally
global.blockedChats = [];
const blockedChatsFile = path.join(__dirname, 'database/blocked_chats.json');
if (fs.existsSync(blockedChatsFile)) {
    try {
        global.blockedChats = JSON.parse(fs.readFileSync(blockedChatsFile, 'utf8'));
    } catch (e) {
        console.error('Failed to parse blocked_chats.json:', e);
    }
}

// Ensure tmp & session directory exists
if (!fs.existsSync('./tmp')) fs.mkdirSync('./tmp');
if (!fs.existsSync('./session')) fs.mkdirSync('./session');

// ─── XYMBOT SESSION DECODER ───────────────────────────────────────────────────
if (process.env.SESSION_ID && process.env.SESSION_ID.startsWith("XYMBOT~")) {
    try {
        console.log("🔄 Decoding Session ID...");
        const base64Data = process.env.SESSION_ID.replace("XYMBOT~", "");
        const sessionJson = JSON.parse(Buffer.from(base64Data, 'base64').toString('utf-8'));
        
        for (const [filename, fileContent] of Object.entries(sessionJson)) {
            const filePath = path.join('./session', filename);
            const contentToWrite = typeof fileContent === 'string' ? fileContent : JSON.stringify(fileContent, null, 2);
            fs.writeFileSync(filePath, contentToWrite);
        }
        console.log("✅ Session files extracted successfully!");
    } catch (e) {
        console.error("❌ Failed to decode SESSION_ID. Ensure you copied the exact code.", e);
    }
}

// ─── LOAD ALL PLUGINS ONCE AT STARTUP ─────────────────────────────────────────
const { commands } = require('./command');
const handlerPlugins = [];

function loadPlugins() {
    handlerPlugins.length = 0; 
    commands.length = 0; 
    const files = fs.readdirSync('./plugins').filter(f => f.endsWith('.js'));
    for (const file of files) {
        try {
            delete require.cache[require.resolve(`./plugins/${file}`)];
            const plugin = require(`./plugins/${file}`);
            if (typeof plugin === 'function' && plugin.command) {
                handlerPlugins.push(plugin);
            }
        } catch (e) {
            console.error(`Failed to load plugin ${file}:`, e.message);
        }
    }
    console.log(`✅ Loaded ${handlerPlugins.length} handler plugins, ${commands.length} cmd plugins.`);
}

async function startBot() {
    // 🚀 DYNAMIC IMPORT FOR ESM COMPATIBILITY (Fixes Render Crash) 🚀
    const {
        default: makeWASocket,
        useMultiFileAuthState,
        DisconnectReason,
        makeCacheableSignalKeyStore,
        fetchLatestBaileysVersion,
        Browsers,
        downloadMediaMessage,
        getAggregateVotesInPollMessage
    } = await import("@whiskeysockets/baileys");

    const { version, isLatest } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState('session');

    console.log(`🤖 Starting bot... WA v${version.join('.')} (isLatest: ${isLatest})`);

    const conn = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        browser: ["Xymbot", "safari", "18.2.0"],
    });

    conn.ev.on('creds.update', saveCreds);

    if (!conn.authState.creds.registered && process.env.PAIRING_NUMBER) {
        setTimeout(async () => {
            try {
                let code = await conn.requestPairingCode(process.env.PAIRING_NUMBER.replace(/[^0-9]/g, ''));
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log(`\n=========================================`);
                console.log(`🔑 YOUR PAIRING CODE IS: ${code}`);
                console.log(`=========================================\n`);
            } catch(e) {
                console.log("Failed to request pairing code:", e);
            }
        }, 3000);
    }

    // ─── AUDIO ID3 TAG INTERCEPTOR ──────────────────────────────────────────────
    const originalSendMessage = conn.sendMessage.bind(conn);
    conn.sendMessage = async (jid, content, options) => {
        if (content && content.audio && !content.ptt && !content.id3Tagged) {
            try {
                const { tagAudio } = require('./plugins/audioUtil.js');
                let audioBuffer = content.audio;

                if (typeof audioBuffer === 'string' && fs.existsSync(audioBuffer)) {
                    audioBuffer = fs.readFileSync(audioBuffer);
                } else if (typeof audioBuffer === 'object' && audioBuffer.url && fs.existsSync(audioBuffer.url)) {
                    audioBuffer = fs.readFileSync(audioBuffer.url);
                }

                if (Buffer.isBuffer(audioBuffer)) {
                    let title = global.botName;
                    let artist = global.ownerName;
                    let thumbPath = path.join(__dirname, './assets/mention/thumb.jpg');
                    let thumbBuf = fs.existsSync(thumbPath) ? fs.readFileSync(thumbPath) : Buffer.alloc(0);

                    let taggedMp3 = await tagAudio(audioBuffer, title, artist, thumbBuf);
                    content.audio = taggedMp3;
                    content.mimetype = 'audio/mpeg';
                }
            } catch (e) {
                console.error("Failed to inject ID3 tags into outgoing audio:", e);
            }
        }
        return originalSendMessage(jid, content, options);
    };

    // ─── MEDIA DOWNLOAD HELPER ─────────────────────────────────────────────────
    conn.downloadAndSaveMediaMessage = async (msgObj) => {
        const rawMsg = msgObj.message || msgObj;
        const msgType = Object.keys(rawMsg).find(k =>
            !['messageContextInfo', 'senderKeyDistributionMessage'].includes(k)
        );
        const ext = msgType === 'imageMessage' ? 'jpg'
            : msgType === 'videoMessage' ? 'mp4'
                : msgType === 'audioMessage' ? 'ogg'
                    : 'bin';

        const buffer = await downloadMediaMessage(
            { key: msgObj.key || {}, message: rawMsg },
            'buffer',
            {},
            { logger: pino({ level: 'silent' }), reuploadRequest: conn.updateMediaMessage }
        );
        const filePath = `./tmp/${Date.now()}.${ext}`;
        fs.writeFileSync(filePath, buffer);
        return filePath;
    };

    conn.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('\n📸 SCAN THE QR CODE BELOW TO CONNECT:\n');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ Connection closed (statusCode: ${statusCode}). Reason:`, lastDisconnect?.error?.message || 'Unknown');
            if (shouldReconnect) {
                console.log('🔄 Reconnecting in 3 seconds...');
                setTimeout(startBot, 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ Connected! Bot is online.');

            const pairedUserJid = conn.user.id;
            const pairedNumber = pairedUserJid ? pairedUserJid.split(':')[0].split('@')[0] : '';
            if (!Array.isArray(global.owner)) global.owner = [];
            if (pairedNumber && !global.owner.includes(pairedNumber)) {
                global.owner.push(pairedNumber);
                console.log(`👑 Paired WhatsApp account (+${pairedNumber}) registered as Bot Owner & Admin.`);
            }

            loadPlugins();

            const targetNumber = pairedNumber || (global.owner && global.owner[0]);
            if (targetNumber) {
                const ownerJid = targetNumber + '@s.whatsapp.net';
                const startTime = Date.now();
                conn.sendMessage(ownerJid, { text: '🔄 *Testing connection latency...*' }).then(async (m) => {
                    const latency = Date.now() - startTime;
                    const totalCommands = commands.length + handlerPlugins.length;
                    const msg = `*🚀 BOT CONNECTED SUCCESSFULLY!*\n\n` +
                        `*🤖 Bot Name:* ${global.botName}\n` +
                        `*👨‍💻 Owner:* 🤍⃞𝄟ꪶ𝐒͢ʏ᪳ᴀ͓м͎ ͢𝐒ᴇ͓ꪳʀ͎𖦻⃞🍓\n` +
                        `*📱 Paired Number:* +${pairedNumber}\n` +
                        `*⚙️ Prefix:* .\n` +
                        `*📦 Total Commands:* ${totalCommands}\n` +
                        `*⚡ Latency:* ${latency}ms\n\n` +
                        `_System ready for operations!_`;
                    await conn.sendMessage(ownerJid, { text: msg });
                }).catch(() => console.log('Could not send startup message to owner.'));
            }
        }
    });

    conn.ev.on('group-participants.update', async (update) => {
        try {
            const groupUpdateHandler = require('./plugins/groupUpdate.js');
            const m = { chat: update.id };
            try {
                m.metadata = await conn.groupMetadata(update.id);
            } catch (e) {
                m.metadata = { subject: 'the group', participants: [] };
            }
            await groupUpdateHandler(m, { conn, participants: update.participants, action: update.action });
        } catch (e) {
            console.error('Group Update Error:', e);
        }
    });

    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const m = chatUpdate.messages[0];
            if (!m || !m.message) return;
            if (m.key.remoteJid === 'status@broadcast') return;

            const msgTime = m.messageTimestamp;
            const currentTime = Math.floor(Date.now() / 1000);
            if (msgTime && (currentTime - msgTime > 60)) return;

            m.chat = m.key.remoteJid;
            m.isGroup = m.chat.endsWith('@g.us');
            m.sender = m.key.fromMe
                ? conn.user.id
                : (m.key.participant || m.key.remoteJid);
            m.senderNumber = m.sender.split('@')[0].split(':')[0];
            m.pushName = m.pushName || 'User';

            m.reply = (text) => conn.sendMessage(m.chat, { text: String(text) }, { quoted: m });

            m.type = Object.keys(m.message).find(k =>
                !['messageContextInfo', 'senderKeyDistributionMessage'].includes(k)
            ) || 'conversation';

            const ctxInfo = m.message?.extendedTextMessage?.contextInfo
                || m.message?.imageMessage?.contextInfo
                || m.message?.videoMessage?.contextInfo
                || m.message?.audioMessage?.contextInfo;

            if (ctxInfo?.quotedMessage) {
                const qType = Object.keys(ctxInfo.quotedMessage)
                    .find(k => !['messageContextInfo'].includes(k));
                m.quoted = {
                    type: qType,
                    message: ctxInfo.quotedMessage,
                    key: {
                        id: ctxInfo.stanzaId,
                        remoteJid: m.chat,
                        fromMe: false,
                        participant: ctxInfo.participant
                    }
                };
                m.quoted.download = () => conn.downloadAndSaveMediaMessage({
                    key: m.quoted.key,
                    message: ctxInfo.quotedMessage
                });
            } else {
                m.quoted = null;
            }

            const body = m.message.conversation
                || m.message.extendedTextMessage?.text
                || m.message.imageMessage?.caption
                || m.message.videoMessage?.caption
                || m.message.buttonsResponseMessage?.selectedButtonId
                || m.message.templateButtonReplyMessage?.selectedId
                || m.message.listResponseMessage?.singleSelectReply?.selectedRowId
                || '';

            const prefix = require('./config').getPrefix() || '.';
            const isCmd = body.startsWith(prefix);
            const command = isCmd ? body.slice(prefix.length).trim().split(/ +/).shift().toLowerCase() : '';
            const args = isCmd ? body.slice(prefix.length).trim().split(/ +/).slice(1) : body.trim().split(/ +/);
            const q = args.join(' ');

            const normalizeJid = (jid) => jid ? jid.split(':')[0].split('@')[0] + '@s.whatsapp.net' : jid;
            const botJid = normalizeJid(conn.user.id);
            const botNumber = conn.user.id ? conn.user.id.split(':')[0].split('@')[0] : '';

            const isFromMe = m.key.fromMe === true;
            const isPairedUser = m.senderNumber === botNumber || normalizeJid(m.sender) === botJid;
            const isConfigOwner = Array.isArray(global.owner) && global.owner.includes(m.senderNumber);
            const isOwner = isFromMe || isPairedUser || isConfigOwner;
            const isSudo = Array.isArray(global.sudo) && global.sudo.includes(m.senderNumber);

            if (global.WORKTYPE === 'private' && !isOwner) return;
            if (global.WORKTYPE === 'sudo' && !isOwner && !isSudo) return;

            const from = m.chat;
            let groupMetadata = null, groupName = '', participants = [],
                groupAdmins = [], isBotAdmins = false, isAdmins = isOwner;

            if (m.isGroup) {
                try {
                    groupMetadata = await conn.groupMetadata(from);
                    groupName = groupMetadata.subject;
                    participants = groupMetadata.participants;
                    const botLidStr = conn.user.lid ? conn.user.lid.split(':')[0].split('@')[0] : '';
                    groupAdmins = participants.filter(v => v.admin === 'admin' || v.admin === 'superadmin').map(v => normalizeJid(v.id));
                    isBotAdmins = groupAdmins.some(adminJid => adminJid.startsWith(botNumber) || (botLidStr && adminJid.startsWith(botLidStr)));
                    isAdmins = isOwner || groupAdmins.includes(normalizeJid(m.sender));
                } catch (_) {
                    if (isOwner) isAdmins = true;
                }
            }

            const reply = async (text) => {
                const textStr = String(text);
                const res = await conn.sendMessage(from, { text: textStr }, { quoted: m });
                if (textStr.toLowerCase().includes('error')) {
                    try {
                        const errorAudio = fs.readFileSync(path.join(__dirname, 'assets/audio/error.mp3'));
                        await conn.sendMessage(from, { audio: errorAudio, mimetype: 'audio/mpeg', ptt: false, id3Tagged: true }, { quoted: m });
                    } catch (e) {
                        console.error('Failed to send error audio:', e);
                    }
                }
                return res;
            };

            const isBlockedChat = global.blockedChats && global.blockedChats.includes(from);

            for (const plugin of handlerPlugins) {
                if (isBlockedChat && !isOwner) continue;

                try {
                    const match = plugin.command instanceof RegExp
                        ? plugin.command.test(command)
                        : Array.isArray(plugin.command)
                            ? plugin.command.includes(command)
                            : plugin.command === command;

                    if (match) {
                        await plugin(m, {
                            conn,
                            args,
                            q,
                            usedPrefix: prefix,
                            command,
                            isOwner,
                            isAdmin: isAdmins,
                            isBotAdmin: isBotAdmins,
                            isROwner: isOwner,
                            from,
                            reply
                        });
                    }
                } catch (e) {
                    console.error(`Plugin Error (handler):`, e.message);
                }
            }

            let isExactCommandMatch = false;

            for (const cmd of commands) {
                if (isBlockedChat && !isOwner) {
                    if (cmd.desc !== 'Auto-responds when bot or SUDO is mentioned') continue;
                }

                try {
                    let match = false;
                    if (isCmd && (cmd.pattern === command || (cmd.alias && cmd.alias.includes(command)))) {
                        match = true;
                        isExactCommandMatch = true;
                    } else if (cmd.on === 'text') {
                        match = true;
                    }

                    if (match) {
                        const sender = m.sender;
                        const senderNumber = m.senderNumber;
                        const pushname = m.pushName;
                        const isMe = isOwner || botJid === normalizeJid(sender);
                        const isGroup = m.isGroup;
                        const botLid = conn.user.lid ? conn.user.lid.split(':')[0] : '';

                        await cmd.function(conn, m, m, {
                            from,
                            quoted: m.quoted,
                            body,
                            isCmd: true,
                            command,
                            args,
                            q,
                            isGroup,
                            sender,
                            senderNumber,
                            botNumber2: botNumber,
                            botNumber,
                            botLid,
                            pushname,
                            isMe,
                            isOwner,
                            groupMetadata,
                            groupName,
                            participants,
                            groupAdmins,
                            isBotAdmins,
                            isAdmins,
                            reply
                        });

                        if (isCmd && global.cmdAudio && !m.audioPlayed) {
                            let matchedCmd = null;
                            if (global.cmdAudio[command]) matchedCmd = command;
                            else if (cmd.alias) {
                                for (let alias of cmd.alias) {
                                    if (global.cmdAudio[alias]) {
                                        matchedCmd = alias;
                                        break;
                                    }
                                }
                            }
                            if (!matchedCmd && typeof cmd.pattern === 'string' && global.cmdAudio[cmd.pattern]) {
                                matchedCmd = cmd.pattern;
                            }

                            if (matchedCmd) {
                                const audioFile = global.cmdAudio[matchedCmd];
                                if (fs.existsSync(audioFile)) {
                                    try {
                                        m.audioPlayed = true; 
                                        await conn.sendMessage(from, { 
                                            audio: fs.readFileSync(audioFile), 
                                            mimetype: 'audio/ogg; codecs=opus', 
                                            ptt: true 
                                        }, { quoted: m });
                                    } catch(e) {
                                        console.error('Failed to send custom cmd audio:', e);
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.erro
