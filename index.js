const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const pino = require('pino');

// CONFIGURATION
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();

app.use(cors());
app.use(express.json());

// GESTION AUTH SUPABASE
const useSupabaseAuth = async (sessionId) => {
    const writeData = async (data, key) => {
        const { error } = await supabase
            .from('whatsapp_sessions')
            .upsert({ session_id: sessionId, key_id: key, data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) });
    };

    const readData = async (key) => {
        const { data } = await supabase
            .from('whatsapp_sessions')
            .select('data')
            .eq('session_id', sessionId)
            .eq('key_id', key)
            .single();
        return data?.data ? JSON.parse(JSON.stringify(data.data), BufferJSON.reviver) : null;
    };

    const removeData = async (key) => {
        await supabase.from('whatsapp_sessions').delete().eq('session_id', sessionId).eq('key_id', key);
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
};

// FONCTION PRINCIPALE
const startWhatsApp = async (instanceId, phoneNumber = null) => {
    console.log(`🚀 Démarrage session ${instanceId} (Phone: ${phoneNumber || 'QR Mode'})`);
    
    try {
        const { state, saveCreds } = await useSupabaseAuth(instanceId);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            // 👇 OPTIMISATION CRITIQUE POUR RENDER GRATUIT 👇
            browser: ["Ubuntu", "Chrome", "20.0.04"], // Identité Linux stable
            syncFullHistory: false,                   // ⚠️ INDISPENSABLE : Empêche le crash mémoire
            generateHighQualityLinkPreview: false,    // Économise le CPU
            connectTimeoutMs: 60000,                  // Laisse le temps au serveur
        });

        // GESTION DU CODE DE JUMELAGE (PAIRING CODE)
        if (phoneNumber && !sock.authState.creds.registered) {
            console.log("⏳ Attente avant demande du code...");
            setTimeout(async () => {
                try {
                    // Nettoyage du numéro
                    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
                    console.log(`📞 Demande de code pour : ${cleanPhone}`);
                    
                    const code = await sock.requestPairingCode(cleanPhone);
                    console.log(`🔑 CODE REÇU : ${code}`);

                    // Envoi direct dans Supabase
                    const { error } = await supabase
                        .from('instances')
                        .update({ qr_code: code, status: 'pairing_code' })
                        .eq('id', instanceId);
                    
                    if(error) console.error("Erreur écriture Supabase:", error);

                } catch (err) {
                    console.error("❌ Erreur Pairing Code:", err.message);
                }
            }, 4000); // On attend 4s que la connexion soit prête
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // Si QR Code (seulement si pas de numéro demandé)
            if (qr && !phoneNumber) {
                console.log("⚡ QR généré");
                await supabase.from('instances').update({ qr_code: qr, status: 'scanning' }).eq('id', instanceId);
            }

            if (connection === 'open') {
                console.log(`✅ CONNECTÉ : ${instanceId}`);
                await supabase.from('instances').update({ qr_code: null, status: 'connected' }).eq('id', instanceId);
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log(`❌ Déconnexion (${lastDisconnect.error?.output?.statusCode}). Reconnexion : ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    startWhatsApp(instanceId, phoneNumber);
                } else {
                    await supabase.from('instances').update({ status: 'disconnected' }).eq('id', instanceId);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);
        
    } catch (e) {
        console.error("Erreur fatale startWhatsApp:", e);
    }
};

// ROUTES
app.get('/', (req, res) => res.send('Worker is Runnnig 🚀'));

app.post('/init-session', async (req, res) => {
    const { instanceId, phoneNumber } = req.body;
    if (!instanceId) return res.status(400).json({ error: 'Missing instanceId' });

    // On lance le processus en arrière-plan
    startWhatsApp(instanceId, phoneNumber).catch(e => console.error(e));

    return res.json({ 
        status: 'initializing', 
        message: phoneNumber ? 'Code en cours...' : 'QR en cours...' 
    });
});

app.listen(PORT, () => console.log(`Serveur sur le port ${PORT}`));
