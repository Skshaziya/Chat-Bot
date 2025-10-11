import React, { useState, useEffect, useRef } from 'react';

// Firebase imports
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, addDoc, query, onSnapshot, orderBy, setDoc, doc } from 'firebase/firestore';

// Fallback constant removed as the AI is now fully unrestricted.

// --- TTS Helper Functions ---
// Converts base64 audio data string to an ArrayBuffer
const base64ToArrayBuffer = (base64) => {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
};

// Converts PCM 16-bit audio data to a WAV Blob for playback
const pcmToWav = (pcmData, sampleRate) => {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);

    const buffer = new ArrayBuffer(44 + pcmData.length * 2);
    const view = new DataView(buffer);

    // RIFF identifier 'RIFF'
    writeString(view, 0, 'RIFF');
    // File size (data length + 36)
    view.setUint32(4, 36 + pcmData.length * 2, true);
    // RIFF type 'WAVE'
    writeString(view, 8, 'WAVE');
    // Format chunk identifier 'fmt '
    writeString(view, 12, 'fmt ');
    // Format chunk length (16)
    view.setUint32(16, 16, true);
    // Sample format (1 for PCM)
    view.setUint16(20, 1, true);
    // Number of channels
    view.setUint16(22, numChannels, true);
    // Sample rate
    view.setUint32(24, sampleRate, true);
    // Byte rate
    view.setUint32(28, byteRate, true);
    // Block align
    view.setUint16(32, blockAlign, true);
    // Bits per sample
    view.setUint16(34, bitsPerSample, true);
    // Data chunk identifier 'data'
    writeString(view, 36, 'data');
    // Data chunk length (PCM data length)
    view.setUint32(40, pcmData.length * 2, true);

    // Write PCM data
    let offset = 44;
    for (let i = 0; i < pcmData.length; i++) {
        view.setInt16(offset, pcmData[i], true);
        offset += 2;
    }

    return new Blob([buffer], { type: 'audio/wav' });
};

// Helper to write string to DataView
const writeString = (view, offset, string) => {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
};

// Main App component
const App = () => {
  // Chat state
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  
  // Auth and User State
  const [userId, setUserId] = useState(null);
  const [nickname, setNickname] = useState(null);
  const [tempNickname, setTempNickname] = useState('');
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isAiProcessing, setIsAiProcessing] = useState(false); // New loading state for AI
  
  const messagesEndRef = useRef(null);

  // Auto-scroll to the bottom of the chat
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // --- Firebase Initialization and Auth Setup ---
  useEffect(() => {
    const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;
    if (!firebaseConfig) {
      console.error("Firebase config not found. Cannot connect to database.");
      return;
    }

    const app = initializeApp(firebaseConfig);
    const db = getFirestore(app);
    const auth = getAuth(app);
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

    // 1. Initial Authentication Check
    const unsubscribeAuth = onAuthStateChanged(auth, async (user) => {
        if (user) {
            setUserId(user.uid);
            setIsAuthReady(true);
        } else {
            // No user signed in, attempt anonymous sign-in
            try {
                // Use custom token if available, otherwise anonymous sign-in
                if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                    await signInWithCustomToken(auth, __initial_auth_token);
                } else {
                    await signInAnonymously(auth);
                }
            } catch (error) {
                console.error("Anonymous sign-in failed:", error);
            }
        }
    });

    // 2. Real-time Messages Listener
    let unsubscribeChat;
    if (isAuthReady && db) {
        const messagesRef = collection(db, `artifacts/${appId}/public/data/messages`);
        const q = query(messagesRef, orderBy('createdAt'));

        unsubscribeChat = onSnapshot(q, (snapshot) => {
            const fetchedMessages = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                // Firestore timestamp conversion for date display
                fetchedMessages.push({ id: doc.id, ...data, createdAt: data.createdAt?.toDate() });
            });
            setMessages(fetchedMessages);
        }, (error) => {
            console.error("Error fetching messages: ", error);
        });
    }

    // Cleanup
    return () => {
        if (unsubscribeAuth) unsubscribeAuth();
        if (unsubscribeChat) unsubscribeChat();
    };
  }, [isAuthReady]);

  // Scroll whenever messages are updated
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // --- Login Handler ---
  const handleSetNickname = () => {
    const trimmedName = tempNickname.trim();
    if (trimmedName.length >= 2) {
      setNickname(trimmedName);
    } else {
      console.log("Nickname must be at least 2 characters.");
    }
  };

  // --- Message Sending Logic (User and AI) ---

  // Function to add a message (used for both user and AI)
  const postMessageToChat = async (text, senderId) => {
    const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;
    if (!firebaseConfig) return;
    const app = initializeApp(firebaseConfig);
    const db = getFirestore(app);
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
    
    try {
        await addDoc(collection(db, `artifacts/${appId}/public/data/messages`), {
            text: text,
            createdAt: new Date(),
            userId: senderId,
            userNickname: senderId === userId ? nickname : 'Gemini (AI Assistant)',
        });
    } catch (error) {
        console.error("Error adding message:", error);
    }
  };

  // --- LLM API Call (General Assistant) ---
  const getGeminiResponse = async (prompt) => {
    setIsAiProcessing(true);
    // General System Instruction to allow the AI to answer all questions.
    const systemPrompt = "You are a friendly, helpful, and concise AI assistant named Gemini. Answer the user's questions accurately and conversationally.";
    
    const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
    };
    
    const apiKey = "";
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API call failed with status ${response.status}: ${errorText}`);
        }
        
        const result = await response.json();
        const botResponse = result?.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't generate a response at this time.";

        // Post the LLM's response
        await postMessageToChat(botResponse, 'Gemini');
    } catch (error) {
        console.error("Error getting Gemini response:", error);
        await postMessageToChat("Error contacting AI service.", 'Gemini');
    } finally {
        setIsAiProcessing(false);
    }
  };

  // --- TTS API Call ---
  const handleTtsClick = async (textToSpeak) => {
    const audio = new Audio();
    
    const payload = {
        contents: [{ parts: [{ text: textToSpeak }] }],
        generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: "Kore" } // Using a clear voice
                }
            }
        },
        model: "gemini-2.5-flash-preview-tts"
    };
    
    const apiKey = "";
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error('TTS API call failed');
        }

        const result = await response.json();
        const part = result?.candidates?.[0]?.content?.parts?.[0];
        const audioData = part?.inlineData?.data;
        const mimeType = part?.inlineData?.mimeType;

        if (audioData && mimeType && mimeType.startsWith("audio/L16")) {
            // Extract sample rate from mimeType, e.g., audio/L16;rate=24000
            const rateMatch = mimeType.match(/rate=(\d+)/);
            const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
            
            // Convert Base64 -> ArrayBuffer -> Int16Array -> WAV Blob
            const pcmData = base64ToArrayBuffer(audioData);
            const pcm16 = new Int16Array(pcmData);
            const wavBlob = pcmToWav(pcm16, sampleRate);
            
            audio.src = URL.createObjectURL(wavBlob);
            audio.play().catch(e => console.error("Audio playback failed:", e));
        } else {
            console.error("TTS response did not contain valid audio data.");
        }

    } catch (error) {
        console.error("Error generating TTS:", error);
    }
  };

  // Main submission handler
  const handleSendMessage = async (e) => {
    e.preventDefault();
    const trimmedMessage = newMessage.trim();
    if (!trimmedMessage || !userId || !nickname || isAiProcessing) return;

    // Post the user's message first
    await postMessageToChat(trimmedMessage, userId);
    setNewMessage(''); 

    // Trigger AI response for every message
    // If the message starts with @gemini, strip the prefix and use the rest as prompt.
    // Otherwise, use the whole message as the prompt.
    const userPrompt = trimmedMessage.toLowerCase().startsWith('@gemini ') 
        ? trimmedMessage.substring(8) 
        : trimmedMessage;

    await getGeminiResponse(userPrompt);
  };

  // --- UI RENDERING ---

  // 1. Login/Nickname Setup Screen
  if (!nickname) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-gray-100 p-4 font-inter">
        <div className="bg-white p-8 rounded-xl shadow-2xl max-w-sm w-full text-center">
          <h1 className="text-3xl font-bold text-blue-600 mb-2">Welcome!</h1>
          <p className="text-gray-600 mb-6">Please set your nickname to start chatting.</p>
          <input
            type="text"
            value={tempNickname}
            onChange={(e) => setTempNickname(e.target.value)}
            placeholder="Enter your nickname"
            className="w-full p-3 mb-4 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            onKeyDown={(e) => e.key === 'Enter' && handleSetNickname()}
            disabled={!isAuthReady}
          />
          <button
            onClick={handleSetNickname}
            className="w-full bg-blue-600 text-white p-3 rounded-lg font-semibold hover:bg-blue-700 transition duration-200 shadow-md disabled:bg-gray-400"
            disabled={!isAuthReady || tempNickname.trim().length < 2}
          >
            Join Chat
          </button>
          {!isAuthReady && <p className="text-sm text-gray-500 mt-4">Connecting to Firebase...</p>}
        </div>
      </div>
    );
  }

  // 2. Main Chat Application Screen
  return (
    <div className="flex flex-col h-screen bg-gray-100 p-4 font-inter">
      {/* Header with user info */}
      <header className="py-3 px-6 bg-white rounded-xl shadow-md mb-4 flex justify-between items-center">
        <h1 className="text-xl font-bold text-gray-800">
            Real-time <span className="text-blue-600">CODTECH</span> Chat
        </h1>
        <div className="text-right">
            <p className="text-sm font-semibold text-gray-800">{nickname}</p>
            <p className="text-xs text-gray-500">
                ID: <span className="font-mono">{userId.substring(0, 8)}...</span>
            </p>
        </div>
      </header>

      {/* Instructions */}
      <div className="text-center bg-yellow-100 p-2 rounded-lg mb-4 text-sm text-yellow-800 shadow-inner">
          The AI is unrestricted and will respond to all your questions!
      </div>
      
      {/* Chat Messages Container: Uses flex-col-reverse for better mobile experience */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-white rounded-xl shadow-md flex flex-col-reverse">
        <div ref={messagesEndRef} />
        
        {/* AI Typing Indicator */}
        {isAiProcessing && (
            <div className="flex justify-start">
                <div className="bg-purple-100 text-purple-900 border border-purple-300 rounded-xl rounded-bl-none p-3 max-w-xs md:max-w-md shadow-lg">
                    <p className="text-xs font-bold mb-1 text-purple-600">Gemini (AI Assistant)</p>
                    <div className="flex items-center space-x-2">
                        <span className="animate-pulse">AI is typing...</span>
                    </div>
                </div>
            </div>
        )}

        {messages.map((msg) => {
          const isMe = msg.userId === userId;
          const isAI = msg.userId === 'Gemini';

          return (
            <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
              <div className={`rounded-xl p-3 max-w-xs md:max-w-md shadow-lg ${
                isMe
                  ? 'bg-blue-600 text-white rounded-br-none'
                  : isAI
                  ? 'bg-purple-100 text-purple-900 border border-purple-300 rounded-bl-none'
                  : 'bg-gray-200 text-gray-800 rounded-bl-none'
              }`}>
                <p className={`text-xs font-bold mb-1 ${isMe ? 'text-blue-200' : (isAI ? 'text-purple-600' : 'text-gray-600')}`}>
                    {isMe ? nickname : msg.userNickname}
                </p>
                <p className="break-words whitespace-pre-wrap">{msg.text}</p>
                
                {/* TTS Button for AI Messages */}
                {isAI && (
                    <button 
                        onClick={() => handleTtsClick(msg.text)}
                        className="mt-2 text-xs text-purple-600 hover:text-purple-800 font-semibold flex items-center transition duration-150"
                    >
                        <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20"><path d="M10 18a8 8 0 100-16 8 8 0 000 16zM7 9a1 1 0 000 2h6a1 1 0 100-2H7z" clipRule="evenodd" fillRule="evenodd"></path></svg>
                        Listen ✨
                    </button>
                )}
                
                <p className="text-[10px] text-right mt-1 opacity-75">
                    {msg.createdAt ? msg.createdAt.toLocaleTimeString() : '...'}
                </p>
              </div>
            </div>
          );
        }).reverse()}
      </div>
      
      {/* Message Input Form */}
      <form onSubmit={handleSendMessage} className="flex gap-2 mt-4">
        <input
          type="text"
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          // Removed @gemini prefix from placeholder as it's no longer mandatory
          placeholder="Type your message or question here..." 
          className="flex-1 p-3 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={!isAuthReady || !nickname || isAiProcessing}
        />
        <button
          type="submit"
          className="bg-blue-600 text-white p-3 px-6 rounded-xl font-semibold hover:bg-blue-700 transition duration-200 shadow-lg disabled:bg-gray-400"
          disabled={!isAuthReady || !nickname || newMessage.trim() === '' || isAiProcessing}
        >
          {isAiProcessing ? (
            <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
          ) : (
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l4.47-1.49a1 1 0 00.672-.082l4.137-2.871a1 1 0 00-.548-1.786L10 13.5l-2.732 1.366a1 1 0 00-.573 1.096l4.469 1.49a1 1 0 001.169-1.409l-7-14z" clipRule="evenodd" fillRule="evenodd"></path></svg>
          )}
        </button>
      </form>
    </div>
  );
};

export default App;
