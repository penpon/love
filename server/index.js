const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// ミドルウェア設定
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

// ルーム管理
const rooms = new Map(); // roomId -> { players: [{id, name, ready, role}], quizState: {}, learningState: {} }

// Socket.IO接続処理
io.on('connection', (socket) => {
  console.log(`ユーザーが接続しました: ${socket.id}`);

  // ルーム参加
  socket.on('join_room', (data) => {
    const { roomId, playerName, role, mode } = data;
    
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        players: [],
        quizState: {
          isActive: false,
          currentQuestion: null,
          scores: {},
          round: 0
        },
        learningState: {
          currentCategory: 'menu',
          scrollPosition: {},
          isActive: false
        }
      });
    }

    const room = rooms.get(roomId);
    
    // 同じ名前・役割の既存プレイヤーがいるかチェック（重複接続対策）
    const existingPlayer = room.players.find(p => 
      p.name === playerName && p.role === role
    );
    
    if (existingPlayer) {
      console.log(`${playerName} (${role}) は既に接続済みのため、古い接続を置き換えます`);
      // 古い接続をクリーンアップ
      room.players = room.players.filter(p => 
        !(p.name === playerName && p.role === role)
      );
      delete room.quizState.scores[existingPlayer.id];
    }
    
    // 既に2人いる場合は拒否（重複チェック後）
    if (room.players.length >= 2) {
      socket.emit('room_full');
      return;
    }

    // プレイヤー情報を追加
    const player = {
      id: socket.id,
      name: playerName,
      role: role || 'guest', // owner または guest
      ready: false
    };
    
    room.players.push(player);
    room.quizState.scores[socket.id] = 0;
    
    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerName = playerName;
    socket.role = role || 'guest';

    console.log(`${playerName} (${role}) が部屋 ${roomId} に参加しました (players: ${room.players.length})`);

    // ルーム状況を両プレイヤーに通知
    socket.emit('room_joined', {
      roomId: roomId,
      playerName: playerName,
      role: role,
      mode: mode
    });

    io.to(roomId).emit('room_status', {
      players: room.players.map(p => ({ name: p.name, ready: p.ready, role: p.role })),
      canStart: room.players.length === 2
    });

    // 2人揃った場合はマッチング完了通知
    if (room.players.length === 2) {
      io.to(roomId).emit('match_found', { players: room.players.map(p => ({ name: p.name, role: p.role })) });
    }
  });

  // プレイヤー準備状態の更新
  socket.on('player_ready', () => {
    if (!socket.roomId) return;
    
    const room = rooms.get(socket.roomId);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.ready = true;
      
      // 両プレイヤーが準備完了の場合、クイズ開始
      if (room.players.length === 2 && room.players.every(p => p.ready)) {
        startQuiz(socket.roomId);
      }
      
      io.to(socket.roomId).emit('room_status', {
        players: room.players.map(p => ({ name: p.name, ready: p.ready })),
        canStart: room.players.length === 2
      });
    }
  });

  // 学習モード: カテゴリー変更の同期
  socket.on('learning_category_change', (data) => {
    const { roomId, category } = data;
    
    if (!socket.roomId || socket.roomId !== roomId) return;
    if (socket.role !== 'owner') return; // Ownerのみ制御可能
    
    const room = rooms.get(roomId);
    if (!room) return;
    
    room.learningState.currentCategory = category;
    room.learningState.isActive = true;
    
    // 他のプレイヤー（Guest）に同期
    socket.to(roomId).emit('learning_category_changed', { category });
    
    console.log(`部屋 ${roomId} で学習カテゴリーが ${category} に変更されました`);
  });

  // 学習モード: スクロール位置の同期
  socket.on('learning_scroll_change', (data) => {
    const { roomId, category, scrollTop } = data;
    
    if (!socket.roomId || socket.roomId !== roomId) return;
    if (socket.role !== 'owner') return; // Ownerのみ制御可能
    
    const room = rooms.get(roomId);
    if (!room) return;
    
    room.learningState.scrollPosition[category] = scrollTop;
    
    // 他のプレイヤー（Guest）に同期
    socket.to(roomId).emit('learning_scroll_sync', { category, scrollTop });
  });

  // ルーム退出
  socket.on('leave_room', (data) => {
    const { roomId } = data;
    
    if (socket.roomId && socket.roomId === roomId) {
      socket.leave(roomId);
      
      const room = rooms.get(roomId);
      if (room) {
        // プレイヤーを削除
        room.players = room.players.filter(p => p.id !== socket.id);
        
        // 他のプレイヤーに退出を通知
        socket.to(roomId).emit('player_left', {
          playerName: socket.playerName,
          role: socket.role
        });
        
        if (room.players.length === 0) {
          rooms.delete(roomId);
          console.log(`部屋 ${roomId} が削除されました`);
        }
      }
      
      socket.roomId = null;
      socket.playerName = null;
      socket.role = null;
      
      console.log(`${socket.playerName} が部屋 ${roomId} を退出しました`);
    }
  });

  // クイズ回答提出
  socket.on('submit_answer', (data) => {
    if (!socket.roomId) return;
    
    const { questionIndex, selectedOption, timeLeft } = data;
    const room = rooms.get(socket.roomId);
    
    if (!room || !room.quizState.isActive) return;

    // 回答を記録
    if (!room.quizState.answers) {
      room.quizState.answers = {};
    }
    
    room.quizState.answers[socket.id] = {
      option: selectedOption,
      timeLeft: timeLeft,
      timestamp: Date.now()
    };

    // 両プレイヤーが回答した場合、結果発表
    const answeredPlayers = Object.keys(room.quizState.answers);
    if (answeredPlayers.length === 2) {
      revealAnswers(socket.roomId, questionIndex);
    }
  });

  // 切断処理
  socket.on('disconnect', () => {
    console.log(`ユーザーが切断しました: ${socket.id} (${socket.playerName || 'unknown'} - ${socket.role || 'unknown'})`);
    
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        // 切断されたプレイヤーの情報を保存
        const disconnectedPlayer = room.players.find(p => p.id === socket.id);
        
        // プレイヤーを削除
        room.players = room.players.filter(p => p.id !== socket.id);
        delete room.quizState.scores[socket.id];
        
        console.log(`部屋 ${socket.roomId} から ${socket.playerName} が切断されました (remaining: ${room.players.length})`);
        
        if (room.players.length === 0) {
          // ルームが空の場合は削除
          rooms.delete(socket.roomId);
          console.log(`部屋 ${socket.roomId} が削除されました`);
        } else {
          // 残ったプレイヤーに通知
          if (disconnectedPlayer) {
            io.to(socket.roomId).emit('player_disconnected', {
              playerName: disconnectedPlayer.name,
              role: disconnectedPlayer.role
            });
          }
          
          io.to(socket.roomId).emit('room_status', {
            players: room.players.map(p => ({ name: p.name, ready: p.ready, role: p.role })),
            canStart: room.players.length === 2
          });
        }
      }
    }
  });
});

// クイズ開始
function startQuiz(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.quizState.isActive = true;
  room.quizState.round = 1;
  
  console.log(`部屋 ${roomId} でクイズを開始します`);
  
  // 最初の問題を出題
  nextQuestion(roomId);
}

// 次の問題を出題
function nextQuestion(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  // サンプル問題（後でJSONファイルから読み込み予定）
  const sampleQuestions = [
    {
      id: 1,
      category: "数値とデータの基礎",
      story: "戦場の通信兵が恋人への暗号化した手紙を送る物語...",
      question: "コンピュータで1バイトは何ビットでしょうか？",
      options: ["4ビット", "8ビット", "16ビット", "32ビット"],
      correctAnswer: 1,
      explanation: "1バイト = 8ビットです。これは世界共通の標準です。"
    },
    {
      id: 2,
      category: "ハードウェア",
      story: "戦時中の機械式計算機の恋物語...",
      question: "CPUの基本的な動作サイクルはどれでしょうか？",
      options: ["読み取り→実行→書き込み", "フェッチ→デコード→実行", "入力→処理→出力", "起動→待機→終了"],
      correctAnswer: 1,
      explanation: "CPUは命令をフェッチ（取得）→デコード（解読）→実行のサイクルで動作します。"
    }
  ];

  const currentQuestion = sampleQuestions[room.quizState.round - 1];
  if (!currentQuestion) {
    // 全問終了
    endQuiz(roomId);
    return;
  }

  room.quizState.currentQuestion = currentQuestion;
  room.quizState.answers = {};
  
  // 問題を出題（正解は除外）
  const questionData = {
    id: currentQuestion.id,
    category: currentQuestion.category,
    story: currentQuestion.story,
    question: currentQuestion.question,
    options: currentQuestion.options,
    round: room.quizState.round,
    timeLimit: 30 // 30秒制限
  };
  
  io.to(roomId).emit('new_question', questionData);
  
  console.log(`部屋 ${roomId} に問題 ${room.quizState.round} を出題しました`);
}

// 回答結果発表
function revealAnswers(roomId, questionIndex) {
  const room = rooms.get(roomId);
  if (!room) return;

  const question = room.quizState.currentQuestion;
  const answers = room.quizState.answers;
  
  const results = [];
  let correctCount = 0;
  
  // 各プレイヤーの結果を集計
  room.players.forEach(player => {
    const playerAnswer = answers[player.id];
    const isCorrect = playerAnswer && playerAnswer.option === question.correctAnswer;
    
    if (isCorrect) {
      correctCount++;
      // 正解時は時間ボーナス付きスコア
      const timeBonus = Math.max(0, playerAnswer.timeLeft);
      const score = 100 + timeBonus;
      room.quizState.scores[player.id] += score;
    }
    
    results.push({
      playerName: player.name,
      selectedOption: playerAnswer ? playerAnswer.option : null,
      isCorrect: isCorrect,
      score: room.quizState.scores[player.id]
    });
  });
  
  // 結果を発表
  io.to(roomId).emit('question_result', {
    correctAnswer: question.correctAnswer,
    explanation: question.explanation,
    results: results,
    scores: room.quizState.scores
  });
  
  console.log(`部屋 ${roomId} の問題 ${room.quizState.round} の結果を発表しました`);
  
  // 3秒後に次の問題へ
  setTimeout(() => {
    room.quizState.round++;
    nextQuestion(roomId);
  }, 5000);
}

// クイズ終了
function endQuiz(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.quizState.isActive = false;
  
  // 最終スコアを計算
  const finalResults = room.players.map(player => ({
    playerName: player.name,
    score: room.quizState.scores[player.id]
  })).sort((a, b) => b.score - a.score);
  
  const winner = finalResults[0];
  
  io.to(roomId).emit('quiz_finished', {
    results: finalResults,
    winner: winner
  });
  
  console.log(`部屋 ${roomId} のクイズが終了しました。勝者: ${winner.playerName}`);
}

// ルートハンドラー
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

// サーバー起動
server.listen(PORT, () => {
  console.log(`🚀 CS学習クイズバトルサーバーが起動しました`);
  console.log(`📡 ポート: ${PORT}`);
  console.log(`🌐 URL: http://localhost:${PORT}`);
});