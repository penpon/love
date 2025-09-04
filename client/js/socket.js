// Socket.io クライアントサイド共通ライブラリ
class SocketManager {
    constructor() {
        this.socket = null;
        this.isConnected = false;
        this.roomId = null;
        this.playerName = null;
        this.eventHandlers = new Map();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
    }

    // Socket.io接続初期化
    initialize(options = {}) {
        if (this.socket) {
            this.socket.disconnect();
        }

        // デフォルトオプション
        const defaultOptions = {
            transports: ['websocket', 'polling'],
            timeout: 20000,
            forceNew: true,
            reconnection: true,
            reconnectionAttempts: this.maxReconnectAttempts,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            randomizationFactor: 0.5
        };

        const socketOptions = { ...defaultOptions, ...options };
        
        try {
            this.socket = io(socketOptions);
            this.setupCommonEventHandlers();
            console.log('Socket.io initialized with options:', socketOptions);
            return true;
        } catch (error) {
            console.error('Socket.io initialization failed:', error);
            return false;
        }
    }

    // 共通イベントハンドラーの設定
    setupCommonEventHandlers() {
        if (!this.socket) return;

        // 接続成功
        this.socket.on('connect', () => {
            this.isConnected = true;
            this.reconnectAttempts = 0;
            console.log('✅ Socket.io connected:', this.socket.id);
            this.updateConnectionStatus('connected');
            this.emit('custom:connected', { socketId: this.socket.id });
        });

        // 接続失敗
        this.socket.on('connect_error', (error) => {
            console.error('❌ Socket.io connection error:', error);
            this.updateConnectionStatus('error', error.message);
            this.emit('custom:connection_error', { error });
        });

        // 切断
        this.socket.on('disconnect', (reason) => {
            this.isConnected = false;
            console.log('⚠️ Socket.io disconnected:', reason);
            this.updateConnectionStatus('disconnected', reason);
            this.emit('custom:disconnected', { reason });

            // 自動再接続の試行
            if (reason === 'io server disconnect') {
                // サーバーから切断された場合は手動で再接続
                setTimeout(() => {
                    if (this.reconnectAttempts < this.maxReconnectAttempts) {
                        this.reconnectAttempts++;
                        console.log(`🔄 Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
                        this.socket.connect();
                    }
                }, 2000);
            }
        });

        // 再接続試行中
        this.socket.on('reconnect_attempt', (attemptNumber) => {
            console.log(`🔄 Reconnect attempt ${attemptNumber}`);
            this.updateConnectionStatus('reconnecting', `Attempt ${attemptNumber}`);
        });

        // 再接続成功
        this.socket.on('reconnect', (attemptNumber) => {
            console.log(`✅ Reconnected after ${attemptNumber} attempts`);
            this.updateConnectionStatus('reconnected');
            this.emit('custom:reconnected', { attemptNumber });
        });

        // 再接続失敗
        this.socket.on('reconnect_failed', () => {
            console.error('❌ Reconnection failed');
            this.updateConnectionStatus('reconnect_failed');
            this.emit('custom:reconnect_failed');
        });

        // デバッグ用：すべてのイベントをログ
        if (window.location.search.includes('debug=true')) {
            const originalOnevent = this.socket.onevent;
            this.socket.onevent = function(packet) {
                console.log('📡 Socket event received:', packet.data);
                originalOnevent.call(this, packet);
            };
        }
    }

    // イベントリスナー追加
    on(event, handler) {
        if (!this.socket) {
            console.warn('Socket not initialized');
            return;
        }

        this.socket.on(event, handler);
        
        // カスタムイベントハンドラーを記録
        if (event.startsWith('custom:')) {
            if (!this.eventHandlers.has(event)) {
                this.eventHandlers.set(event, []);
            }
            this.eventHandlers.get(event).push(handler);
        }
    }

    // イベント送信
    emit(event, data) {
        if (!this.socket || !this.isConnected) {
            console.warn('Socket not connected, queuing event:', event);
            // 接続されるまで待機
            if (this.socket) {
                this.socket.on('connect', () => {
                    this.socket.emit(event, data);
                });
            }
            return;
        }

        console.log('📤 Sending event:', event, data);
        this.socket.emit(event, data);
    }

    // カスタムイベント発行
    emit(event, data) {
        if (event.startsWith('custom:')) {
            const handlers = this.eventHandlers.get(event) || [];
            handlers.forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    console.error('Error in custom event handler:', error);
                }
            });
        } else {
            if (this.socket && this.isConnected) {
                this.socket.emit(event, data);
            }
        }
    }

    // 接続状態の更新
    updateConnectionStatus(status, message = '') {
        const statusElements = document.querySelectorAll('[id*="connection"], [id*="status"]');
        const statusMessages = {
            connected: { text: '💚 接続中', color: '#00ff00' },
            connecting: { text: '🔄 接続中...', color: '#ffaa00' },
            disconnected: { text: '🔴 切断', color: '#ff0000' },
            error: { text: '❌ エラー', color: '#ff0000' },
            reconnecting: { text: '🔄 再接続中...', color: '#ffaa00' },
            reconnected: { text: '✅ 再接続完了', color: '#00ff00' },
            reconnect_failed: { text: '❌ 再接続失敗', color: '#ff0000' }
        };

        const statusInfo = statusMessages[status] || { text: status, color: '#cccccc' };
        
        statusElements.forEach(element => {
            if (element.textContent) {
                element.textContent = statusInfo.text + (message ? ` (${message})` : '');
                element.style.color = statusInfo.color;
            }
        });

        // カスタムイベント発行
        this.emit('custom:status_changed', { status, message, statusInfo });
    }

    // ルーム参加
    joinRoom(roomId, playerName, options = {}) {
        if (!roomId || !playerName) {
            throw new Error('ルームIDとプレイヤー名は必須です');
        }

        this.roomId = roomId;
        this.playerName = playerName;

        const joinData = {
            roomId: roomId.trim(),
            playerName: playerName.trim(),
            ...options
        };

        console.log('🏛️ Joining room:', joinData);
        this.emit('join_room', joinData);
    }

    // ルーム退出
    leaveRoom() {
        if (this.roomId) {
            console.log('🚪 Leaving room:', this.roomId);
            this.emit('leave_room', { roomId: this.roomId });
            this.roomId = null;
            this.playerName = null;
        }
    }

    // 切断
    disconnect() {
        if (this.socket) {
            console.log('🔌 Disconnecting socket');
            this.leaveRoom();
            this.socket.disconnect();
            this.socket = null;
            this.isConnected = false;
        }
    }

    // 接続状態取得
    getConnectionState() {
        return {
            isConnected: this.isConnected,
            socketId: this.socket?.id,
            roomId: this.roomId,
            playerName: this.playerName
        };
    }

    // デバッグ情報取得
    getDebugInfo() {
        return {
            ...this.getConnectionState(),
            transport: this.socket?.io?.engine?.transport?.name,
            reconnectAttempts: this.reconnectAttempts,
            eventHandlers: Array.from(this.eventHandlers.keys())
        };
    }
}

// クイズ専用のSocket管理クラス
class QuizSocketManager extends SocketManager {
    constructor() {
        super();
        this.gameState = {
            isInGame: false,
            currentQuestion: null,
            selectedAnswer: null,
            timeLeft: 0,
            scores: {},
            round: 0
        };
        this.timers = new Map();
    }

    // クイズ固有のイベント処理を初期化
    initializeQuizEvents() {
        // 新しい問題受信
        this.on('new_question', (questionData) => {
            console.log('❓ New question received:', questionData);
            this.gameState.currentQuestion = questionData;
            this.gameState.selectedAnswer = null;
            this.gameState.isInGame = true;
            this.gameState.round = questionData.round;
            
            this.emit('custom:new_question', questionData);
            this.startQuestionTimer(questionData.timeLimit || 30);
        });

        // 問題結果受信
        this.on('question_result', (resultData) => {
            console.log('📊 Question result:', resultData);
            this.clearTimer('question');
            this.gameState.scores = resultData.scores || {};
            this.emit('custom:question_result', resultData);
        });

        // クイズ終了
        this.on('quiz_finished', (finalData) => {
            console.log('🏁 Quiz finished:', finalData);
            this.gameState.isInGame = false;
            this.clearAllTimers();
            this.emit('custom:quiz_finished', finalData);
        });

        // プレイヤー切断通知
        this.on('player_disconnected', (data) => {
            console.log('👋 Player disconnected:', data);
            this.emit('custom:player_disconnected', data);
        });

        // ルーム状況更新
        this.on('room_status', (data) => {
            console.log('🏛️ Room status update:', data);
            this.emit('custom:room_status', data);
        });

        // マッチング成功
        this.on('match_found', (data) => {
            console.log('🎯 Match found:', data);
            this.emit('custom:match_found', data);
        });

        // ルーム満室
        this.on('room_full', () => {
            console.log('🚫 Room is full');
            this.emit('custom:room_full');
        });
    }

    // 回答送信
    submitAnswer(questionIndex, selectedOption, timeLeft = 0) {
        const answerData = {
            questionIndex,
            selectedOption,
            timeLeft,
            timestamp: Date.now()
        };

        console.log('📝 Submitting answer:', answerData);
        this.gameState.selectedAnswer = selectedOption;
        this.emit('submit_answer', answerData);
        this.clearTimer('question');
    }

    // 準備完了通知
    sendPlayerReady() {
        console.log('✅ Player ready');
        this.emit('player_ready');
    }

    // 問題タイマー開始
    startQuestionTimer(duration) {
        this.clearTimer('question');
        this.gameState.timeLeft = duration;

        const timer = setInterval(() => {
            this.gameState.timeLeft--;
            this.emit('custom:timer_tick', { 
                timeLeft: this.gameState.timeLeft,
                duration 
            });

            if (this.gameState.timeLeft <= 0) {
                this.clearTimer('question');
                if (this.gameState.selectedAnswer === null) {
                    // 時間切れで未回答の場合は null を送信
                    this.submitAnswer(
                        this.gameState.round - 1,
                        null,
                        0
                    );
                }
            }
        }, 1000);

        this.timers.set('question', timer);
    }

    // 特定のタイマーをクリア
    clearTimer(name) {
        if (this.timers.has(name)) {
            clearInterval(this.timers.get(name));
            this.timers.delete(name);
        }
    }

    // すべてのタイマーをクリア
    clearAllTimers() {
        this.timers.forEach((timer, name) => {
            clearInterval(timer);
        });
        this.timers.clear();
    }

    // クイズ状態取得
    getQuizState() {
        return { ...this.gameState };
    }

    // 切断時のクリーンアップ
    disconnect() {
        this.clearAllTimers();
        this.gameState.isInGame = false;
        super.disconnect();
    }
}

// ユーティリティ関数
class SocketUtils {
    // URLパラメータ取得
    static getUrlParams() {
        const urlParams = new URLSearchParams(window.location.search);
        return {
            roomId: urlParams.get('roomId'),
            playerName: urlParams.get('playerName'),
            mode: urlParams.get('mode'),
            debug: urlParams.get('debug') === 'true'
        };
    }

    // パラメータ検証
    static validateParams(params) {
        const errors = [];
        
        if (!params.roomId || params.roomId.length < 4) {
            errors.push('ルームIDは4文字以上で入力してください');
        }
        
        if (!params.playerName || params.playerName.length < 2) {
            errors.push('プレイヤー名は2文字以上で入力してください');
        }
        
        return errors;
    }

    // エラーハンドラー
    static handleError(error, context = '') {
        console.error(`[${context}] Error:`, error);
        
        const errorMessages = {
            'connection refused': 'サーバーに接続できませんでした',
            'timeout': '接続がタイムアウトしました',
            'transport error': '通信エラーが発生しました'
        };
        
        const message = errorMessages[error.message] || error.message || '不明なエラーが発生しました';
        
        // エラー表示
        SocketUtils.showNotification(message, 'error');
    }

    // 通知表示
    static showNotification(message, type = 'info', duration = 5000) {
        // 既存の通知があれば削除
        const existingNotification = document.getElementById('socket-notification');
        if (existingNotification) {
            existingNotification.remove();
        }

        // 通知要素作成
        const notification = document.createElement('div');
        notification.id = 'socket-notification';
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 10000;
            padding: 15px 20px;
            border-radius: 8px;
            color: white;
            font-family: inherit;
            font-weight: bold;
            max-width: 300px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            animation: slideIn 0.3s ease-out;
        `;

        // タイプ別スタイル
        const typeStyles = {
            info: 'background: linear-gradient(135deg, #0066cc, #0088ff)',
            success: 'background: linear-gradient(135deg, #00aa00, #00ff00)',
            warning: 'background: linear-gradient(135deg, #ff8800, #ffaa00)',
            error: 'background: linear-gradient(135deg, #cc0000, #ff0000)'
        };

        notification.style.background = typeStyles[type] || typeStyles.info;
        notification.textContent = message;

        // アニメーション
        const style = document.createElement('style');
        style.textContent = `
            @keyframes slideIn {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes slideOut {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(100%); opacity: 0; }
            }
        `;
        document.head.appendChild(style);

        document.body.appendChild(notification);

        // クリックで閉じる
        notification.addEventListener('click', () => {
            notification.style.animation = 'slideOut 0.3s ease-in forwards';
            setTimeout(() => notification.remove(), 300);
        });

        // 自動削除
        if (duration > 0) {
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.style.animation = 'slideOut 0.3s ease-in forwards';
                    setTimeout(() => notification.remove(), 300);
                }
            }, duration);
        }
    }

    // デバッグ情報表示
    static showDebugInfo(socketManager) {
        if (window.location.search.includes('debug=true')) {
            const debugInfo = socketManager.getDebugInfo();
            console.table(debugInfo);
            
            // 画面に表示
            let debugPanel = document.getElementById('debug-panel');
            if (!debugPanel) {
                debugPanel = document.createElement('div');
                debugPanel.id = 'debug-panel';
                debugPanel.style.cssText = `
                    position: fixed;
                    bottom: 10px;
                    left: 10px;
                    background: rgba(0, 0, 0, 0.9);
                    color: #00ff00;
                    padding: 10px;
                    font-family: monospace;
                    font-size: 12px;
                    border: 1px solid #00aa00;
                    border-radius: 5px;
                    z-index: 9999;
                    max-width: 300px;
                `;
                document.body.appendChild(debugPanel);
            }
            
            debugPanel.innerHTML = `
                <strong>Debug Info:</strong><br>
                Connected: ${debugInfo.isConnected}<br>
                Socket ID: ${debugInfo.socketId || 'None'}<br>
                Room: ${debugInfo.roomId || 'None'}<br>
                Player: ${debugInfo.playerName || 'None'}<br>
                Transport: ${debugInfo.transport || 'None'}<br>
                Reconnects: ${debugInfo.reconnectAttempts}
            `;
        }
    }

    // ページ離脱時の警告
    static setupBeforeUnloadWarning(socketManager) {
        window.addEventListener('beforeunload', (event) => {
            if (socketManager.isConnected && socketManager.roomId) {
                const message = '対戦中です。本当にページを離れますか？';
                event.preventDefault();
                event.returnValue = message;
                return message;
            }
        });
    }

    // キーボードショートカット設定
    static setupKeyboardShortcuts(handlers = {}) {
        document.addEventListener('keydown', (event) => {
            // Escキー: メニューやダイアログを閉じる
            if (event.key === 'Escape' && handlers.escape) {
                handlers.escape(event);
            }
            
            // F5キー: デバッグ情報表示
            if (event.key === 'F5' && event.ctrlKey && handlers.debug) {
                event.preventDefault();
                handlers.debug(event);
            }
            
            // 数字キー: 選択肢選択
            if (/^[1-4]$/.test(event.key) && handlers.selectOption) {
                event.preventDefault();
                handlers.selectOption(parseInt(event.key) - 1);
            }
            
            // エンターキー: 確認・送信
            if (event.key === 'Enter' && handlers.confirm) {
                handlers.confirm(event);
            }
        });
    }
}

// グローバル変数として利用可能にする
window.SocketManager = SocketManager;
window.QuizSocketManager = QuizSocketManager;
window.SocketUtils = SocketUtils;

// デフォルトエクスポート（モジュール環境用）
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SocketManager,
        QuizSocketManager,
        SocketUtils
    };
}

// 共通初期化処理
document.addEventListener('DOMContentLoaded', () => {
    // 共通のエラーハンドラーを設定
    window.addEventListener('error', (event) => {
        console.error('Unhandled error:', event.error);
        if (event.error?.message?.includes('socket')) {
            SocketUtils.handleError(event.error, 'Global');
        }
    });

    // 未処理のPromise拒否
    window.addEventListener('unhandledrejection', (event) => {
        console.error('Unhandled promise rejection:', event.reason);
        if (event.reason?.message?.includes('socket')) {
            SocketUtils.handleError(event.reason, 'Promise');
        }
    });

    console.log('🚀 Socket.io client library loaded successfully');
});