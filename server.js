const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// public 폴더 안의 HTML 파일 서비스
app.use(express.static(path.join(__dirname, 'public')));

// 데이터 저장용 JSON 파일 경로
const DATA_FILE = path.join(__dirname, 'data.json');

// 기본 초기 상태
const defaultState = {
    currentPin: null,
    boxText: 'Type your text\nhere.',
    textSince: Date.now(),
    status: 'STATUS: UNCLAIMED'
};

// 1. 파일에서 이전 데이터 불러오기 함수
function loadGameState() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const fileData = fs.readFileSync(DATA_FILE, 'utf8');
            console.log('📂 기존 저장된 게임 데이터를 파일에서 복원했습니다.');
            return JSON.parse(fileData);
        }
    } catch (err) {
        console.error('❌ 데이터 불러오기 실패 (기본값 사용):', err);
    }
    return { ...defaultState };
}

// 2. 파일에 데이터 영구 저장 함수
function saveGameState() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(gameState, null, 2), 'utf8');
        console.log('💾 최신 게임 상태가 data.json에 영구 저장되었습니다.');
    } catch (err) {
        console.error('❌ 데이터 저장 실패:', err);
    }
}

// 서버 실행 시 저장된 데이터 복원
let gameState = loadGameState();

io.on('connection', (socket) => {
    console.log('⚡ 유저 접속:', socket.id);

    // 유저 접속 시 현재 상자 상태 전송
    socket.emit('syncState', {
        boxText: gameState.boxText,
        textSince: gameState.textSince,
        status: gameState.status,
        isLocked: gameState.currentPin !== null
    });

    // PIN 잠금 해제 시도
    socket.on('tryUnlock', (inputPin, callback) => {
        if (gameState.currentPin === null) {
            callback({ success: true, message: 'Unclaimed' });
        } else if (gameState.currentPin === inputPin) {
            callback({ success: true });
        } else {
            callback({ success: false, message: 'Incorrect PIN' });
        }
    });

    // 상자 탈취 후 새 문구 & PIN 등록
    socket.on('claimBox', ({ newText, newPin }, callback) => {
        if (!/^\d{4}$/.test(newPin)) {
            return callback({ success: false, message: 'Invalid PIN' });
        }

        gameState.currentPin = newPin;
        gameState.boxText = newText.trim() === '' ? 'Type your text\nhere.' : newText;
        gameState.textSince = Date.now();
        gameState.status = 'STATUS: LOCKED';

        console.log(`🔒 상자 탈취 완료! 새 PIN: [${newPin}]`);

        // 파일에 즉시 기록 (서버가 잠들어도 보존)
        saveGameState();

        // 모든 유저에게 실시간 브로드캐스트
        io.emit('syncState', {
            boxText: gameState.boxText,
            textSince: gameState.textSince,
            status: gameState.status,
            isLocked: true
        });

        callback({ success: true });
    });

    socket.on('disconnect', () => {
        console.log('❌ 유저 퇴장:', socket.id);
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🎮 Hijack This Game Server Running!`);
    console.log(`👉 접속 주소: http://localhost:${PORT}`);
    console.log(`=========================================`);
});