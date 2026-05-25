import 'dotenv/config';
import http from 'http';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TWITCH_CHANNEL_NAME = process.env.TWITCH_CHANNEL_NAME;

const PORT = process.env.PORT || 3000;
const CHECK_INTERVAL_MS = 30000;

let twitchAccessToken = null;
let isStreamLive = false;

const server = http.createServer((req, res) => {
    if (req.url === '/no_sleep') {
        const time = new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow' });
        console.log(`[${time}] Эндпоинт /no_sleep вызван. Сервер поддерживает активность.`);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Awake\n');
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Twitch Telegram Bot is running!\n');
    }
});

server.listen(PORT, () => {
    console.log(`Web-сервер запущен на порту ${PORT}`);
});

async function getTwitchAccessToken() {
    const url = `https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`;
    const response = await fetch(url, { method: 'POST' });
    const data = await response.json();
    
    if (!response.ok) {
        throw new Error(`Ошибка получения токена Twitch: ${JSON.stringify(data)}`);
    }
    
    twitchAccessToken = data.access_token;
    console.log("Успешно получен или обновлен токен доступа Twitch.");
}

async function checkStreamStatus() {
    if (!twitchAccessToken) {
        await getTwitchAccessToken();
    }

    const url = `https://api.twitch.tv/helix/streams?user_login=${TWITCH_CHANNEL_NAME}`;
    let response = await fetch(url, {
        headers: {
            'Client-ID': TWITCH_CLIENT_ID,
            'Authorization': `Bearer ${twitchAccessToken}`
        }
    });

    if (response.status === 401) {
        console.log("Токен Twitch истек. Выполняется обновление токена...");
        await getTwitchAccessToken();
        response = await fetch(url, {
            headers: {
                'Client-ID': TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${twitchAccessToken}`
            }
        });
    }

    const data = await response.json();
    
    if (!response.ok) {
        console.error(`Ошибка Twitch API: ${JSON.stringify(data)}`);
        return;
    }

    const streamData = data.data;
    
    if (streamData && streamData.length > 0) {
        if (!isStreamLive) {
            isStreamLive = true;
            const stream = streamData[0];
            await sendTelegramMessage(stream);
        }
    } else {
        isStreamLive = false;
    }
}

async function sendTelegramMessage(stream) {
    // Формируем ссылку на превью. Twitch отдает строку с {width} и {height}.
    // Добавляем timestamp (?t=...), чтобы Telegram не кэшировал картинку с прошлого стрима.
    const thumbnailUrl = stream.thumbnail_url
        .replace('{width}', '1280')
        .replace('{height}', '720') + `?t=${Date.now()}`;

    // Формируем текст под картинкой
    const caption = `Новый стрим на канале <b>${stream.user_name}</b>!\n\n` +
                    `<b>Название:</b> ${stream.title}\n` +
                    `<b>Категория:</b> ${stream.game_name}`;

    // Создаем кнопку под сообщением
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

    // Используем метод sendPhoto вместо sendMessage
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
        console.error(`Ошибка Telegram API при отправке сообщения: ${JSON.stringify(data)}`);
    } else {
        console.log(`Уведомление об эфире с превью успешно отправлено в чат ${TELEGRAM_CHAT_ID}.`);
    }
}

async function startBot() {
    console.log(`Бот запущен. Отслеживается канал Twitch: ${TWITCH_CHANNEL_NAME}`);
    console.log(`ID Telegram чата для уведомлений: ${TELEGRAM_CHAT_ID}`);
    
    try {
        await checkStreamStatus();
    } catch (error) {
        console.error("Ошибка при первой проверке:", error.message);
        if (error.cause) {
            console.error("Детали сетевой ошибки:", error.cause);
        }
    }
    
    setInterval(async () => {
        try {
            await checkStreamStatus();
        } catch (error) {
            console.error("Ошибка во время цикличной проверки статуса:", error.message);
            if (error.cause) {
                console.error("Детали сетевой ошибки:", error.cause);
            }
        }
    }, CHECK_INTERVAL_MS);
}

startBot();