import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TWITCH_CHANNEL_NAME = process.env.TWITCH_CHANNEL_NAME;
const TWITCH_WEBHOOK_SECRET = process.env.TWITCH_WEBHOOK_SECRET;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;

const PORT = process.env.PORT || 3000;
const PING_INTERVAL_MS = 300000;

let twitchAccessToken = null;
let broadcasterId = null;

const app = express();

function getTime() {
    return new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow' });
}

// Middleware для сохранения сырого тела запроса. Это критически важно для проверки подписи Twitch.
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

app.get('/no_sleep', (req, res) => {
    console.log(`[${getTime()}] Эндпоинт /no_sleep вызван. Сервер поддерживает активность.`);
    res.status(200).send('Awake\n');
});

app.get('/status', (req, res) => {
    res.status(200).json({ status: "ok" });
});

app.get('/', (req, res) => {
    res.status(200).send('Twitch Telegram Bot is running on EventSub Webhooks!\n');
});

// Функция проверки цифровой подписи Twitch
function verifyTwitchSignature(req, res, next) {
    const messageId = req.headers['twitch-eventsub-message-id'];
    const timestamp = req.headers['twitch-eventsub-message-timestamp'];
    const messageSignature = req.headers['twitch-eventsub-message-signature'];

    if (!messageId || !timestamp || !messageSignature) {
        console.warn(`[${getTime()}] Отклонен запрос без необходимых заголовков EventSub.`);
        return res.status(403).send('Forbidden');
    }

    const message = messageId + timestamp + req.rawBody;
    const signature = 'sha256=' + crypto.createHmac('sha256', TWITCH_WEBHOOK_SECRET).update(message).digest('hex');

    if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(messageSignature))) {
        next();
    } else {
        console.warn(`[${getTime()}] Отклонен запрос с неверной подписью.`);
        res.status(403).send('Invalid signature');
    }
}

// Эндпоинт для приема вебхуков от Twitch
app.post('/twitch/webhook', verifyTwitchSignature, async (req, res) => {
    const messageType = req.headers['twitch-eventsub-message-type'];

    // Ответ на Challenge при регистрации подписки
    if (messageType === 'webhook_callback_verification') {
        const challenge = req.body.challenge;
        console.log(`[${getTime()}] Успешно пройдена проверка подлинности (Challenge) для вебхука.`);
        return res.status(200).send(challenge);
    }

    // Обработка уведомлений о событиях
    if (messageType === 'notification') {
        const event = req.body.event;
        const subscriptionType = req.body.subscription.type;

        if (subscriptionType === 'stream.online') {
            console.log(`[${getTime()}] Получено уведомление: Стрим на канале ${event.broadcaster_user_name} начался.`);
            // Событие stream.online не содержит превью, запрашиваем данные потока
            const streamData = await getStreamData(event.broadcaster_user_id);
            if (streamData) {
                await sendTelegramMessage(streamData);
            }
        } else if (subscriptionType === 'stream.offline') {
            console.log(`[${getTime()}] Получено уведомление: Стрим на канале ${event.broadcaster_user_name} завершен.`);
        }
        
        return res.sendStatus(204);
    }

    res.sendStatus(200);
});

async function getTwitchAccessToken() {
    const url = `https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`;
    const response = await fetch(url, { method: 'POST' });
    const data = await response.json();
    
    if (!response.ok) {
        throw new Error(`Ошибка получения токена Twitch: ${JSON.stringify(data)}`);
    }
    
    twitchAccessToken = data.access_token;
    console.log(`[${getTime()}] Успешно получен токен доступа Twitch.`);
}

async function getBroadcasterId() {
    const url = `https://api.twitch.tv/helix/users?login=${TWITCH_CHANNEL_NAME}`;
    const response = await fetch(url, {
        headers: {
            'Client-ID': TWITCH_CLIENT_ID,
            'Authorization': `Bearer ${twitchAccessToken}`
        }
    });

    const data = await response.json();
    
    if (!response.ok || data.data.length === 0) {
        throw new Error(`Не удалось найти пользователя Twitch с логином ${TWITCH_CHANNEL_NAME}`);
    }

    broadcasterId = data.data[0].id;
    console.log(`[${getTime()}] Определен ID канала ${TWITCH_CHANNEL_NAME}: ${broadcasterId}`);
}

async function getStreamData(userId) {
    const url = `https://api.twitch.tv/helix/streams?user_id=${userId}`;
    const response = await fetch(url, {
        headers: {
            'Client-ID': TWITCH_CLIENT_ID,
            'Authorization': `Bearer ${twitchAccessToken}`
        }
    });

    const data = await response.json();
    
    if (!response.ok || data.data.length === 0) {
        console.error(`[${getTime()}] Не удалось получить данные потока для формирования превью.`);
        return null;
    }

    return data.data[0];
}

async function subscribeToEventSub(type) {
    const url = 'https://api.twitch.tv/helix/eventsub/subscriptions';
    const body = {
        type: type,
        version: '1',
        condition: {
            broadcaster_user_id: broadcasterId
        },
        transport: {
            method: 'webhook',
            callback: `${RENDER_EXTERNAL_URL}/twitch/webhook`,
            secret: TWITCH_WEBHOOK_SECRET
        }
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Client-ID': TWITCH_CLIENT_ID,
            'Authorization': `Bearer ${twitchAccessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (response.status === 409) {
        console.log(`[${getTime()}] Подписка на событие ${type} уже существует.`);
        return;
    }

    const data = await response.json();
    
    if (!response.ok) {
        console.error(`[${getTime()}] Ошибка подписки на ${type}: ${JSON.stringify(data)}`);
    } else {
        console.log(`[${getTime()}] Успешно зарегистрирована подписка на событие: ${type}`);
    }
}

async function sendTelegramMessage(stream) {
    const thumbnailUrl = stream.thumbnail_url
        .replace('{width}', '1280')
        .replace('{height}', '720') + `?t=${Date.now()}`;

    const caption = `Новый стрим на канале <b>${stream.user_name}</b>!\n\n` +
                    `Присоединяйтесь!\n`;

    const replyMarkup = {
        inline_keyboard: [
            [
                {
                    text: "Смотреть на Twitch",
                    url: `https://twitch.tv/${TWITCH_CHANNEL_NAME}`
                }
            ]
        ]
    };

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            photo: thumbnailUrl,
            caption: caption,
            parse_mode: 'HTML',
            reply_markup: replyMarkup
        })
    });

    const data = await response.json();
    
    if (!response.ok) {
        console.error(`[${getTime()}] Ошибка Telegram API при отправке сообщения: ${JSON.stringify(data)}`);
    } else {
        console.log(`[${getTime()}] Уведомление об эфире с превью успешно отправлено в чат ${TELEGRAM_CHAT_ID}.`);
    }
}

function startSelfPing() {
    if (!RENDER_EXTERNAL_URL) {
        console.log(`[${getTime()}] Переменная RENDER_EXTERNAL_URL не найдена. Самопинг отключен.`);
        return;
    }

    console.log(`[${getTime()}] Настроен автоматический самопинг на адрес: ${RENDER_EXTERNAL_URL}/no_sleep`);
    
    setInterval(async () => {
        try {
            const response = await fetch(`${RENDER_EXTERNAL_URL}/no_sleep`);
            if (!response.ok) {
                console.error(`[${getTime()}] Ошибка самопинга. Статус: ${response.status}`);
            }
        } catch (error) {
            console.error(`[${getTime()}] Сетевая ошибка при попытке самопинга:`, error.message);
        }
    }, PING_INTERVAL_MS);
}

app.listen(PORT, async () => {
    console.log(`===========================================`);
    console.log(`[${getTime()}] Web-сервер запущен на порту ${PORT}`);
    
    if (!RENDER_EXTERNAL_URL) {
        console.error(`[${getTime()}] ВНИМАНИЕ: Для работы EventSub необходимо указать RENDER_EXTERNAL_URL.`);
        return;
    }

    try {
        await getTwitchAccessToken();
        await getBroadcasterId();
        
        await subscribeToEventSub('stream.online');
        await subscribeToEventSub('stream.offline');
        
        startSelfPing();
    } catch (error) {
        console.error(`[${getTime()}] Ошибка при инициализации:`, error.message);
    }
});