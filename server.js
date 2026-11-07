const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
app.set('trust proxy', true);

const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// JSONBin 설정 (공백 제거 안전 처리)
const BIN_ID = '6ae4208bac6210605a5df4ce'.trim();
const API_KEY = '$2a$10$f.isaInIxfslRDo2c53fvOx4egu6L6iZ2XU22IF2tEpyb1ycV.b.i '.trim();

const MAX_TOKENS = 12;
const REFILL_MS = 10 * 60 * 1000; // 10분당 1개 충전

// IP 및 하드웨어 기기 지문(Fingerprint) 통합 토큰 관리 테이블
const tokenMap = new Map();

// 클라이언트 실제 네트워크 식별자 정규화 (IPv4 매핑 및 IPv6 시크릿창 임시주소 회전 대응)
function getNormalizedIpKey(socket) {
    const headers = socket.handshake.headers;
    let rawIp =
        headers['cf-connecting-ip'] ||
        headers['x-real-ip'] ||
        (headers['x-forwarded-for'] ? headers['x-forwarded-for'].split(',')[0].trim() : '') ||
        socket.handshake.address ||
        'unknown';

    if (rawIp.startsWith('::ffff:')) {
        rawIp = rawIp.substring(7);
    }
    // IPv6 주소인 경우 시크릿 창 임시 주소 변경을 막기 위해 앞 4블록(/64 서브넷) 기준으로 고정
    if (rawIp.includes(':')) {
        const parts = rawIp.split(':');
        if (parts.length >= 4) {
            rawIp = parts.slice(0, 4).join(':');
        }
    }
    return 'ip_' + crypto.createHash('sha256').update(rawIp).digest('hex').slice(0, 16);
}

// 클라이언트 하드웨어 지문 정규화
function getDeviceKey(socket) {
    const rawFp = String((socket.handshake.auth && socket.handshake.auth.fp) || '').trim();
    if (!rawFp || rawFp.length < 8) return null;
    return 'fp_' + crypto.createHash('sha256').update(rawFp).digest('hex').slice(0, 16);
}

// 단일 키의 시간 경과 토큰 충전 계산
function computeRefilledState(state, now) {
    if (state.tokens >= MAX_TOKENS) {
        state.tokens = MAX_TOKENS;
        state.lastRefill = now;
        return state;
    }
    const elapsed = Math.max(0, now - state.lastRefill);
    const gained = Math.floor(elapsed / REFILL_MS);
    if (gained > 0) {
        state.tokens = Math.min(MAX_TOKENS, state.tokens + gained);
        state.lastRefill += gained * REFILL_MS;
        if (state.tokens >= MAX_TOKENS) state.lastRefill = now;
    }
    return state;
}

// 시크릿 창 우회 원천 차단: IP 키와 하드웨어 기기 지문 키 중 더 엄격한(남은 토큰이 적은) 상태를 동기화 적용
function getUnifiedTokenState(socket) {
    const now = Date.now();
    const ipKey = getNormalizedIpKey(socket);
    const fpKey = getDeviceKey(socket);

    let ipState = tokenMap.get(ipKey);
    let fpState = fpKey ? tokenMap.get(fpKey) : null;

    if (ipState) ipState = computeRefilledState(ipState, now);
    if (fpState) fpState = computeRefilledState(fpState, now);

    let unified;
    if (ipState && fpState) {
        // 둘 중 토큰이 더 적게 남은 쪽으로 강제 동기화 (시크릿 창 우회 차단)
        unified = ipState.tokens <= fpState.tokens
            ? { tokens: ipState.tokens, lastRefill: ipState.lastRefill }
            : { tokens: fpState.tokens, lastRefill: fpState.lastRefill };
    } else if (ipState) {
        unified = { tokens: ipState.tokens, lastRefill: ipState.lastRefill };
    } else if (fpState) {
        unified = { tokens: fpState.tokens, lastRefill: fpState.lastRefill };
    } else {
        unified = { tokens: MAX_TOKENS, lastRefill: now };
    }

    tokenMap.set(ipKey, { ...unified });
    if (fpKey) tokenMap.set(fpKey, { ...unified });

    return {
        state: unified,
        saveUpdate: (newTokens, newLastRefill) => {
            const updated = { tokens: newTokens, lastRefill: newLastRefill };
            tokenMap.set(ipKey, { ...updated });
            if (fpKey) tokenMap.set(fpKey, { ...updated });
            syncTokensToGameState();
        }
    };
}

let gameState = {
    currentPin: null,
    boxText: 'Type your text\nhere.',
    textSince: Date.now(),
    status: 'STATUS: UNCLAIMED',
    failedPins: [],
    tokenRecords: {}
};

// 메모리 내 활성 토큰 쿨타임을 gameState에 병합 (서버 재시작 시에도 시크릿창 쿨타임 유지)
function syncTokensToGameState() {
    const now = Date.now();
    const records = {};
    for (const [k, v] of tokenMap.entries()) {
        if (v.tokens < MAX_TOKENS && (now - v.lastRefill) < MAX_TOKENS * REFILL_MS) {
            records[k] = v;
        }
    }
    gameState.tokenRecords = records;
}

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
                    const rec = parsed.record;
                    // 기존 4자리 PIN이 저장되어 있을 경우 3자리로 자동 마이그레이션
                    let pin = rec.currentPin || null;
                    if (pin !== null) {
                        pin = String(pin).replace(/[^0-9]/g, '').slice(0, 3).padStart(3, '0');
                    }

                    gameState = {
                        currentPin: pin,
                        boxText: rec.boxText || 'Type your text\nhere.',
                        textSince: rec.textSince || Date.now(),
                        status: pin ? 'STATUS: LOCKED' : 'STATUS: UNCLAIMED',
                        failedPins: Array.isArray(rec.failedPins) ? rec.failedPins : [],
                        tokenRecords: rec.tokenRecords || {}
                    };

                    // 저장된 토큰 쿨타임 복원
                    if (gameState.tokenRecords && typeof gameState.tokenRecords === 'object') {
                        for (const [k, v] of Object.entries(gameState.tokenRecords)) {
                            if (v && typeof v.tokens === 'number' && typeof v.lastRefill === 'number') {
                                tokenMap.set(k, {
                                    tokens: Math.min(MAX_TOKENS, v.tokens),
                                    lastRefill: v.lastRefill
                                });
                            }
                        }
                    }
                    console.log('📂 외부 DB 복원 완료 | 현재 PIN 자리수:', pin ? pin.length : 'UNCLAIMED');
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
    syncTokensToGameState();
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
    const tokenCtx = getUnifiedTokenState(socket);

    socket.emit('syncState', {
        boxText: gameState.boxText,
        textSince: gameState.textSince,
        status: gameState.status,
        isLocked: gameState.currentPin !== null,
        failedCount: gameState.failedPins.length,
        tokens: tokenCtx.state.tokens,
        lastRefill: tokenCtx.state.lastRefill
    });

    // 3자리 PIN 해제 시도
    socket.on('tryUnlock', (inputPin, callback) => {
        const cleanPin = String(inputPin || '').trim();
        if (!/^\d{3}$/.test(cleanPin)) {
            return callback({
                success: false,
                message: '3자리 숫자를 정확히 입력해주세요.'
            });
        }

        if (gameState.currentPin !== null) {
            const currentTokenCtx = getUnifiedTokenState(socket);
            const tokenState = currentTokenCtx.state;

            // [패치 4] 누군가 이미 시도해서 실패한 번호인지 먼저 확인 (토큰 차감 안 함)
            if (gameState.failedPins.includes(cleanPin)) {
                return callback({
                    success: false,
                    alreadyTried: true,
                    tokens: tokenState.tokens,
                    lastRefill: tokenState.lastRefill,
                    failedCount: gameState.failedPins.length,
                    message: '이미 누군가가 시도해본 번호입니다.'
                });
            }

            // 남은 토큰 확인
            if (tokenState.tokens <= 0) {
                return callback({
                    success: false,
                    noTokens: true,
                    tokens: 0,
                    lastRefill: tokenState.lastRefill,
                    failedCount: gameState.failedPins.length,
                    message: '남은 토큰이 없습니다. 다음 충전까지 기다려주세요.'
                });
            }

            // 새로운 번호 시도이므로 토큰 1개 차감
            let newLastRefill = tokenState.lastRefill;
            if (tokenState.tokens === MAX_TOKENS) {
                newLastRefill = Date.now();
            }
            const newTokens = tokenState.tokens - 1;
            currentTokenCtx.saveUpdate(newTokens, newLastRefill);

            // 정답 판정
            if (gameState.currentPin === cleanPin) {
                saveRemoteData();
                return callback({
                    success: true,
                    tokens: newTokens,
                    lastRefill: newLastRefill,
                    failedCount: gameState.failedPins.length
                });
            } else {
                // 오답일 경우 글로벌 실패 목록에 등록하여 다른 유저들이 중복 실패하지 않도록 보호
                if (!gameState.failedPins.includes(cleanPin)) {
                    gameState.failedPins.push(cleanPin);
                }
                saveRemoteData();

                // 전체 접속자에게 소거된 번호 개수 실시간 브로드캐스트
                io.emit('telemetryUpdate', {
                    failedCount: gameState.failedPins.length
                });

                return callback({
                    success: false,
                    noTokens: newTokens <= 0,
                    tokens: newTokens,
                    lastRefill: newLastRefill,
                    failedCount: gameState.failedPins.length,
                    message: `일치하지 않는 코드입니다. (남은 토큰: ${newTokens}개)`
                });
            }
        }

        // UNCLAIMED 상태일 때
        callback({
            success: true,
            tokens: tokenCtx.state.tokens,
            lastRefill: tokenCtx.state.lastRefill,
            failedCount: 0
        });
    });

    // 상자 점유 및 새로운 3자리 PIN 설정
    socket.on('claimBox', ({ newText, newPin }, callback) => {
        const cleanPin = String(newPin || '').trim();
        if (!/^\d{3}$/.test(cleanPin)) {
            return callback({ success: false, message: '새로운 3자리 숫자를 입력해주세요.' });
        }

        gameState.currentPin = cleanPin;
        gameState.boxText = String(newText || '').trim() === '' ? 'Type your text\nhere.' : String(newText);
        gameState.textSince = Date.now();
        gameState.status = 'STATUS: LOCKED';
        gameState.failedPins = []; // 새 비밀번호로 잠기면 기존 실패 번호 기록 초기화

        console.log(`🔒 코어 통제권 갱신 완료! 새 3자리 PIN: [${cleanPin}]`);
        saveRemoteData();

        io.emit('syncState', {
            boxText: gameState.boxText,
            textSince: gameState.textSince,
            status: gameState.status,
            isLocked: true,
            failedCount: 0
        });

        callback({ success: true });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🛰️ HIJACK THIS Core Server Active on Port ${PORT}`);
});