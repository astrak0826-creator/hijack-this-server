const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// public 폴더 안의 HTML 파일을 브라우저로 서비스
app.use(express.static(path.join(__dirname, 'public')));

// 서버가 중앙에서 보관하는 진짜 데이터 (치팅 방지)
let gameState = {
    currentPin: null,
    boxText: 'Type your text\nhere.',
    textSince: Date.now(),
    status: 'STATUS: UNCLAIMED'
};

io.on('connection', (socket) => {
    console.log('⚡ 유저 접속:', socket.id);

    // 1. 유저 접속 시 현재 상자 상태 전송 (비밀번호는 숨김)
    socket.emit('syncState', {
        boxText: gameState.boxText,
        textSince: gameState.textSince,
        status: gameState.status,
        isLocked: gameState.currentPin !== null
    });

    // 2. 유저가 비밀번호(PIN)를 입력해 해킹을 시도할 때
    socket.on('tryUnlock', (inputPin, callback) => {
        if (gameState.currentPin === null) {
            callback({ success: true, message: 'Unclaimed' });
        } else if (gameState.currentPin === inputPin) {
            callback({ success: true });
        } else {
            callback({ success: false, message: 'Incorrect PIN' });
        }
    });

    // 3. 해킹 성공 후 새 문구와 새 PIN 번호를 등록했을 때
    socket.on('claimBox', ({ newText, newPin }, callback) => {
        if (!/^\d{4}$/.test(newPin)) {
            return callback({ success: false, message: 'Invalid PIN' });
        }

        gameState.currentPin = newPin;
        gameState.boxText = newText.trim() === '' ? 'Type your text\nhere.' : newText;
        gameState.textSince = Date.now();
        gameState.status = 'STATUS: LOCKED';

        console.log(`🔒 상자가 탈취되었습니다! 새 PIN: [${newPin}]`);

        // 접속 중인 모든 플레이어에게 변경된 상자 실시간 반영
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