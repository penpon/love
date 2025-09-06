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
// 学習用データ(JSON)の静的配信
app.use('/data', express.static(path.join(__dirname, '../data')));

// ルーム管理
const rooms = new Map(); // roomId -> { players: [{id, name, ready, role}], quizState: {}, learningState: {} }

// Ownerセッション管理
const ownerSessions = new Map(); // ownerName -> { currentRoomId, previousRoomIds: [] }

// Ownerの画面遷移中（ロビー→モード選択など）を一時的に保護するための管理
// roomId -> { ownerName: string, timestamp: number, cleanupTimer: NodeJS.Timeout }
const transitioningOwners = new Map();

// Ownerのルーム作成処理（過去ルーム自動削除）
function handleOwnerRoomCreation(ownerName, newRoomId, socket) {
  const existingSession = ownerSessions.get(ownerName);
  
  if (existingSession && existingSession.currentRoomId && existingSession.currentRoomId !== newRoomId) {
    const oldRoomId = existingSession.currentRoomId;
    const oldRoom = rooms.get(oldRoomId);
    
    if (oldRoom) {
      console.log(`Owner ${ownerName} が新しいルーム ${newRoomId} を作成するため、古いルーム ${oldRoomId} を閉鎖します`);
      
      // 古いルームの参加者に通知
      socket.to(oldRoomId).emit('room_closed_by_owner', {
        message: '主催者が新しいルームを作成したため、このルームは閉じられました',
        ownerName: ownerName,
        newRoomId: newRoomId
      });
      
      // 古いルームのプレイヤーを切断
      if (oldRoom.players) {
        oldRoom.players.forEach(player => {
          if (player.role === 'guest') {
            io.sockets.sockets.get(player.id)?.disconnect(true);
          }
        });
      }
      
      // 古いルームを削除
      rooms.delete(oldRoomId);
      
      // 履歴に記録
      if (!existingSession.previousRoomIds) {
        existingSession.previousRoomIds = [];
      }
      existingSession.previousRoomIds.push(oldRoomId);
    }
  }
  
  // 新しいルームをセッションに記録
  ownerSessions.set(ownerName, {
    currentRoomId: newRoomId,
    previousRoomIds: existingSession?.previousRoomIds || []
  });
}

// Socket.IO接続処理
io.on('connection', (socket) => {
  console.log(`ユーザーが接続しました: ${socket.id}`);

  // ルーム参加
  socket.on('join_room', (data) => {
    const { roomId, playerName, role, mode } = data;
    
    // Ownerが新しいルームを作成する場合、過去のルームを自動削除
    if (role === 'owner') {
      handleOwnerRoomCreation(playerName, roomId, socket);
    }
    
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
          isActive: false,
          selectedStory: {}
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

    // 学習中の章スナップショットを新規参加者へ送信（初期同期）
    try {
      const snapshot = {
        currentCategory: room.learningState.currentCategory,
        selectedStory: room.learningState.selectedStory || {}
      };
      socket.emit('learning_story_snapshot', snapshot);
    } catch (e) {
      console.warn('learning_story_snapshot emit failed:', e);
    }

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
    
    if (!room.learningState) {
      room.learningState = { currentCategory: 'menu', scrollPosition: {}, isActive: false, selectedStory: {} };
    }
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
    
    if (!room.learningState) room.learningState = { currentCategory: 'menu', scrollPosition: {}, isActive: false, selectedStory: {} };
    if (!room.learningState.scrollPosition) room.learningState.scrollPosition = {};
    room.learningState.scrollPosition[category] = scrollTop;
    
    // 他のプレイヤー（Guest）に同期
    socket.to(roomId).emit('learning_scroll_sync', { category, scrollTop });
  });

  // 学習モード: 物語選択の同期（Owner→Guest）
  socket.on('learning_story_change', (data) => {
    const { roomId, category, chapterId } = data || {};
    if (!socket.roomId || socket.roomId !== roomId) return;
    if (socket.role !== 'owner') return; // Ownerのみ制御可能

    const room = rooms.get(roomId);
    if (!room) return;

    try {
      // 状態更新
      if (!room.learningState) room.learningState = { currentCategory: 'menu', scrollPosition: {}, isActive: false, selectedStory: {} };
      room.learningState.currentCategory = category || room.learningState.currentCategory || 'menu';
      if (!room.learningState.selectedStory) room.learningState.selectedStory = {};
      if (category && chapterId != null) {
        room.learningState.selectedStory[category] = chapterId;
      }

      // 他参加者へ同期配信
      socket.to(roomId).emit('learning_story_changed', { category, chapterId });
      console.log(`部屋 ${roomId} で物語が変更されました: category=${category}, chapter=${chapterId}`);
    } catch (e) {
      console.warn('learning_story_change で例外:', e);
    }
  });

  // モード選択画面への遷移（Ownerが先に進む時）
  socket.on('proceed_to_mode_select', (data) => {
    const { roomId } = data;
    
    if (!socket.roomId || socket.roomId !== roomId) return;
    if (socket.role !== 'owner') return; // Ownerのみ実行可能
    
    const room = rooms.get(roomId);
    if (!room) return;
    
    console.log(`Owner ${socket.playerName} がモード選択画面へ遷移します (ルーム: ${roomId})`);
    
    // 遷移中フラグをセット（10秒のグレース期間）
    try {
      const existing = transitioningOwners.get(roomId);
      if (existing?.cleanupTimer) {
        clearTimeout(existing.cleanupTimer);
      }
      const cleanupTimer = setTimeout(() => {
        const info = transitioningOwners.get(roomId);
        if (!info) return;
        const r = rooms.get(roomId);
        if (!r) {
          transitioningOwners.delete(roomId);
          return;
        }
        // まだ再接続していない場合は、Ownerを正式に切断扱いにする
        const ownerIdx = r.players.findIndex(p => p.role === 'owner' && p.name === info.ownerName);
        if (ownerIdx !== -1) {
          const ownerPlayer = r.players[ownerIdx];
          // プレイヤー削除とスコア掃除
          r.players.splice(ownerIdx, 1);
          delete r.quizState.scores[ownerPlayer.id];
          console.log(`遷移猶予切れ: ルーム ${roomId} の Owner ${ownerPlayer.name} を切断扱いにしました`);
          // 残ったプレイヤーに通知とステータス更新
          io.to(roomId).emit('player_disconnected', {
            playerName: ownerPlayer.name,
            role: ownerPlayer.role
          });
          io.to(roomId).emit('room_status', {
            players: r.players.map(p => ({ name: p.name, ready: p.ready, role: p.role })),
            canStart: r.players.length === 2
          });
          if (r.players.length === 0) {
            rooms.delete(roomId);
            console.log(`部屋 ${roomId} が削除されました (遷移猶予切れ後に全員不在)`);
          }
        }
        transitioningOwners.delete(roomId);
      }, 10000);
      transitioningOwners.set(roomId, {
        ownerName: socket.playerName,
        timestamp: Date.now(),
        cleanupTimer
      });
    } catch (e) {
      console.warn('遷移中フラグ設定で例外:', e);
    }
    
    // Guestにモード選択画面への遷移を通知
    socket.to(roomId).emit('owner_proceeded_to_mode_select', {
      roomId: roomId,
      ownerName: socket.playerName
    });
  });

  // モード選択画面での接続（両プレイヤー）
  socket.on('mode_select_join', (data) => {
    const { roomId, playerName, role, recovery } = data;
    
    console.log(`${playerName} (${role}) がモード選択画面に接続しました (ルーム: ${roomId}${recovery ? ' - 復旧モード' : ''})`);
    
    // 入力値の検証
    if (!roomId || !playerName || !role) {
      console.log(`モード選択画面接続時に必要なパラメータが不足: roomId=${roomId}, playerName=${playerName}, role=${role}`);
      socket.emit('room_not_found');
      return;
    }
    
    socket.roomId = roomId;
    socket.playerName = playerName;
    socket.role = role;
    socket.join(roomId);
    
    let room = rooms.get(roomId);
    if (!room) {
      console.log(`警告: ルーム ${roomId} が見つかりません。利用可能ルーム: ${Array.from(rooms.keys()).join(', ')}`);
      
      // 復旧モードの場合、ルームを再作成する
      if (recovery) {
        console.log(`復旧モード: ルーム ${roomId} を再作成します`);
        room = {
          id: roomId,
          players: [],
          mode: null,
          createdAt: Date.now(),
          quizState: {
            isActive: false,
            currentQuestion: null,
            scores: {},
            round: 0
          },
          learningState: {
            currentCategory: 'menu',
            scrollPosition: {},
            isActive: false,
            selectedStory: {}
          }
        };
        rooms.set(roomId, room);
      } else {
        socket.emit('room_not_found');
        return;
      }
    }
    
    // ルーム状態の必須プロパティを補完（後方互換・復旧時対策）
    if (!room.quizState) {
      room.quizState = { isActive: false, currentQuestion: null, scores: {}, round: 0 };
    } else if (!room.quizState.scores) {
      room.quizState.scores = {};
    }
    if (!room.learningState) {
      room.learningState = { currentCategory: 'menu', scrollPosition: {}, isActive: false, selectedStory: {} };
    } else {
      if (!room.learningState.scrollPosition) room.learningState.scrollPosition = {};
      if (!room.learningState.selectedStory) room.learningState.selectedStory = {};
    }
    
    // ロビー→モード選択の遷移中であれば、猶予フラグを解除
    if (role === 'owner') {
      const transitionInfo = transitioningOwners.get(roomId);
      if (transitionInfo && transitionInfo.ownerName === playerName) {
        try {
          if (transitionInfo.cleanupTimer) clearTimeout(transitionInfo.cleanupTimer);
        } catch (e) {}
        transitioningOwners.delete(roomId);
        console.log(`遷移完了: ルーム ${roomId} の Owner ${playerName} の遷移フラグを解除しました`);
      }
    }
    
    // プレイヤーが既にルームに存在するかチェック
    const existingPlayer = room.players.find(p => p.name === playerName && p.role === role);
    if (existingPlayer) {
      // 既存プレイヤーの接続IDを更新（スコアも引き継ぎ）
      const oldId = existingPlayer.id;
      existingPlayer.id = socket.id;
      if (room.quizState?.scores && room.quizState.scores.hasOwnProperty(oldId)) {
        room.quizState.scores[socket.id] = room.quizState.scores[oldId];
        delete room.quizState.scores[oldId];
      }
      console.log(`${playerName} (${role}) の接続IDを更新しました`);
    } else {
      // 新しいプレイヤーの場合、ルーム状況を詳しく確認
      console.log(`新規プレイヤー ${playerName} (${role}) がルームに参加を試みています`);
      console.log(`現在のルーム状況: ${room.players.map(p => `${p.name}(${p.role})`).join(', ')}`);
      
      // 復旧モードの場合、プレイヤー情報を再作成
      if (recovery) {
        console.log(`復旧モード: プレイヤー ${playerName} (${role}) の情報を復元します`);
        room.players.push({
          id: socket.id,
          name: playerName,
          role: role,
          ready: false
        });
        console.log(`プレイヤー復元完了: ${playerName} (${role})`);
      } else {
        // 通常モードでも、遷移中に切断扱いになったケース等に備えて不足プレイヤーを再追加
        const sameRolePlayers = room.players.filter(p => p.role === role);
        if (sameRolePlayers.length === 0 && room.players.length < 2) {
          room.players.push({
            id: socket.id,
            name: playerName,
            role: role,
            ready: false
          });
          console.log(`プレイヤーを再追加: ${playerName} (${role})`);
        } else {
          console.log(`警告: ${role} として接続しようとしていますが、該当する役割のプレイヤーがルームに存在しません`);
        }
      }
    }
    
    socket.emit('mode_select_connected', {
      roomId: roomId,
      playerName: playerName,
      role: role,
      players: room.players.map(p => ({ name: p.name, role: p.role }))
    });
    
    // 相手プレイヤーにも接続状況を通知
    socket.to(roomId).emit('player_reconnected', {
      playerName: playerName,
      role: role
    });
  });

  // 学習モード選択（Ownerのみ）
  socket.on('select_learning_mode', (data) => {
    const { roomId } = data;
    
    if (!socket.roomId || socket.roomId !== roomId) return;
    if (socket.role !== 'owner') return; // Ownerのみ実行可能
    
    const room = rooms.get(roomId);
    if (!room) return;
    
    if (!room.learningState) {
      room.learningState = {
        currentCategory: 'menu',
        scrollPosition: {},
        isActive: false,
        selectedStory: {}
      };
    }
    room.learningState.isActive = true;
    room.learningState.currentCategory = 'menu';
    
    console.log(`Owner ${socket.playerName} が学習モードを選択しました (ルーム: ${roomId})`);
    
    // 両プレイヤーを学習画面へ遷移
    io.to(roomId).emit('redirect_to_learning', {
      roomId: roomId,
      message: '学習モードが選択されました。学習画面へ移動します。'
    });
  });

  // クイズモード選択（Ownerのみ）
  socket.on('select_quiz_mode', (data) => {
    const { roomId } = data;
    
    if (!socket.roomId || socket.roomId !== roomId) return;
    if (socket.role !== 'owner') return; // Ownerのみ実行可能
    
    const room = rooms.get(roomId);
    if (!room) return;
    
    if (!room.quizState) {
      room.quizState = { isActive: false, currentQuestion: null, scores: {}, round: 0 };
    }
    room.quizState.isActive = true;
    
    console.log(`Owner ${socket.playerName} がクイズモードを選択しました (ルーム: ${roomId})`);
    
    // 両プレイヤーをマッチング画面へ遷移
    io.to(roomId).emit('redirect_to_matching', {
      roomId: roomId,
      message: 'クイズモードが選択されました。マッチング画面へ移動します。'
    });
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
        // Ownerがモード選択へ遷移中の場合は、一定時間は切断扱いにしない
        const t = transitioningOwners.get(socket.roomId);
        const isOwnerTransitioning = t && socket.role === 'owner' && t.ownerName === socket.playerName;
        if (isOwnerTransitioning) {
          console.log(`Owner ${socket.playerName} は遷移中のため、一時的な切断を無視します (ルーム: ${socket.roomId})`);
          return;
        }
        // 切断されたプレイヤーの情報を保存
        const disconnectedPlayer = room.players.find(p => p.id === socket.id);
        
        // Ownerが切断された場合、セッション情報をクリーンアップ
        if (socket.role === 'owner' && socket.playerName) {
          const ownerSession = ownerSessions.get(socket.playerName);
          if (ownerSession && ownerSession.currentRoomId === socket.roomId) {
            ownerSessions.delete(socket.playerName);
            console.log(`Owner ${socket.playerName} のセッション情報をクリーンアップしました`);
          }
        }
        
        // プレイヤーを削除
        room.players = room.players.filter(p => p.id !== socket.id);
        delete room.quizState.scores[socket.id];
        
        console.log(`部屋 ${socket.roomId} から ${socket.playerName} が切断されました (remaining: ${room.players.length})`);
        
        if (room.players.length === 0) {
          // ルームが空の場合は削除
          rooms.delete(socket.roomId);
          console.log(`部屋 ${socket.roomId} が削除されました (全プレイヤーが切断)`);
          
          // Ownerセッション情報もクリーンアップ
          if (socket.role === 'owner' && socket.playerName) {
            const ownerSession = ownerSessions.get(socket.playerName);
            if (ownerSession && ownerSession.currentRoomId === socket.roomId) {
              ownerSessions.delete(socket.playerName);
              console.log(`Owner ${socket.playerName} のセッション情報を最終クリーンアップしました`);
            }
          }
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