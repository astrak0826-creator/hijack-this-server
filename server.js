const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
// 프록시(Render 클라우드 환경) 뒤에서 실제 유저 IP를 읽어오기 위한 필수 설정
app.set('trust proxy', true);

const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ★ 본인의 JSONBin ID와 API 키를 넣어주세요
const BIN_ID = '여기에_복사한_BIN_ID_입력';
const API_KEY = '여기에_복사한_Master_Key_입력';

const MAX_TOKENS = 5;
const REFILL_MS = 10 * 60 * 1000; // 10분

// IP별 토큰 정보를 보관하는 메모리 테이블
// 형식: { 'IP주소': { tokens: 5, lastRefill: 1730000000000 } }
const ipTokenMap = new Map();

// 유저의 실제 IP 추출 함수
function getClientIp(socket) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return socket.handshake.address;
}

// IP 기준 토큰 충전 및 반환 함수
function getIpTokenState(ip) {
    const now = Date.now();
    let state = ipTokenMap.get(ip);

    if (!state) {
        state = { tokens: MAX_TOKENS, lastRefill: now };
        ipTokenMap.set(ip, state);
        return state;
    }

    if (state.tokens >= MAX_TOKENS) {
        state.tokens = MAX_TOKENS;
        state.lastRefill = now;
        return state;
    }

    // 시간 경과에 따른 토큰 충전 계산
    const gained = Math.floor((now - state.lastRefill) / REFILL_MS);
    if (gained > 0) {
        state.tokens = Math.min(MAX_TOKENS, state.tokens + gained);
        state.lastRefill += gained * REFILL_MS;
        if (state.tokens >= MAX_TOKENS) state.lastRefill = now;
    }

    return state;
}

let gameState = {
    currentPin: null,
    boxText: 'Type your text\nhere.',
    textSince: Date.now(),
    status: 'STATUS: UNCLAIMED'
};

function fetchRemoteData() {
    if (!BIN_ID || BIN_ID.includes('여기')) return;
    const options = {
        hostname: 'api.jsonbin.io',
        path: `/v3/b/${BIN_ID}/latest`,
        method: 'GET',
        headers: { 'X-Master-Key': API_KEY }
    };

    const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
            try {
                const parsed = JSON.parse(body);
                if (parsed.record) {
                    gameState = parsed.record;
                    console.log('📂 외부 DB 복원 완료:', gameState);
                }
            } catch (e) {
                console.error('DB 파싱 에러:', e);
            }
        });
    });
    req.on('error', (err) => console.error('DB 로드 에러:', err));
    req.end();
}

function saveRemoteData() {
    if (!BIN_ID || BIN_ID.includes('여기')) return;
    const payload = JSON.stringify(gameState);
    const options = {
        hostname: 'api.jsonbin.io',
        path: `/v3/b/${BIN_ID}`,
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'X-Master-Key': API_KEY
        }
    };
    const req = https.request(options, () => {});
    req.on('error', (err) => console.error('DB 저장 에러:', err));
    req.write(payload);
    req.end();
}

fetchRemoteData();

io.on('connection', (socket) => {
    const userIp = getClientIp(socket);
    const userTokens = getIpTokenState(userIp);

    // 접속한 유저에게 현재 상자 상태 + 유저 IP 기준 토큰 정보 전송
    socket.emit('syncState', {
        boxText: gameState.boxText,
        textSince: gameState.textSince,
        status: gameState.status,
        isLocked: gameState.currentPin !== null,
        tokens: userTokens.tokens,
        lastRefill: userTokens.lastRefill
    });

    // PIN 해제 시도
    socket.on('tryUnlock', (inputPin, callback) => {
        // 상자가 잠겨있는 경우 서버에서 직접 토큰 검증
        if (gameState.currentPin !== null) {
            const tokenState = getIpTokenState(userIp);
            if (tokenState.tokens <= 0) {
                return callback({
                    success: false,
                    noTokens: true,
                    tokens: 0,
                    lastRefill: tokenState.lastRefill,
                    message: '남은 토큰이 없습니다. 다음 충전까지 기다려주세요.'
                });
            }

            // 시도 1회당 서버에서 토큰 1 차감
            if (tokenState.tokens === MAX_TOKENS) {
                tokenState.lastRefill = Date.now();
            }
            tokenState.tokens--;

            if (gameState.currentPin === inputPin) {
                return callback({ success: true, tokens: tokenState.tokens, lastRefill: tokenState.lastRefill });
            } else {
                return callback({
                    success: false,
                    noTokens: tokenState.tokens <= 0,
                    tokens: tokenState.tokens,
                    lastRefill: tokenState.lastRefill,
                    message: '틀린 비밀번호입니다.'
                });
            }
        }

        // 언클레임 상태
        callback({ success: true, tokens: MAX_TOKENS, lastRefill: Date.now() });
    });

    socket.on('claimBox', ({ newText, newPin }, callback) => {
        if (!/^\d{4}$/.test(newPin)) {
            return callback({ success: false, message: 'Invalid PIN' });
        }

        gameState.currentPin = newPin;
        gameState.boxText = newText.trim() === '' ? 'Type your text\nhere.' : newText;
        gameState.textSince = Date.now();
        gameState.status = 'STATUS: LOCKED';

        console.log(`🔒 상자 탈취 완료! 새 PIN: [${newPin}]`);
        saveRemoteData();

        io.emit('syncState', {
            boxText: gameState.boxText,
            textSince: gameState.textSince,
            status: gameState.status,
            isLocked: true
        });

        callback({ success: true });
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🎮 Game Server with IP-RateLimiting on Port ${PORT}`);
});