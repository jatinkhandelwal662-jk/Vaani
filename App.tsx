import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { decode, encode, decodeAudioData, createBlob } from './src/services/audioUtils';
import { SYSTEM_INSTRUCTION, ORGANIZATION, OFFICER_NAME } from './src/constants';
import { TranscriptionItem } from './src/types';
import Visualizer from './src/components/Visualizer';

const App: React.FC = () => {
  const [isCalling, setIsCalling] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [transcripts, setTranscripts] = useState<TranscriptionItem[]>([]);
  const [currentInput, setCurrentInput] = useState('');
  const [currentOutput, setCurrentOutput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const inputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<any>(null);
  const autoEndTimerRef = useRef<number | null>(null);

  const currentInputRef = useRef('');
  const currentOutputRef = useRef('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      const { scrollHeight, clientHeight } = scrollRef.current;
      scrollRef.current.scrollTo({
        top: scrollHeight - clientHeight,
        behavior: 'smooth'
      });
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(scrollToBottom, 50);
    return () => clearTimeout(timer);
  }, [transcripts, currentInput, currentOutput, scrollToBottom]);

  const cleanup = useCallback((keepHistory = true) => {
    if (autoEndTimerRef.current) {
      window.clearTimeout(autoEndTimerRef.current);
      autoEndTimerRef.current = null;
    }

    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    sourcesRef.current.clear();
    
    if (inputAudioCtxRef.current) {
      inputAudioCtxRef.current.close().catch(() => {});
      inputAudioCtxRef.current = null;
    }
    if (outputAudioCtxRef.current) {
      outputAudioCtxRef.current.close().catch(() => {});
      outputAudioCtxRef.current = null;
    }

    setIsCalling(false);
    setIsConnecting(false);
    setIsClosing(false);
    nextStartTimeRef.current = 0;
    currentInputRef.current = '';
    currentOutputRef.current = '';
    setCurrentInput('');
    setCurrentOutput('');
    if (!keepHistory) {
      setTranscripts([]);
    }
  }, []);

  const handleCall = async () => {
    if (isCalling || isConnecting || isClosing) {
      cleanup();
      return;
    }

    try {
      setIsConnecting(true);
      setError(null);

      // 1. Audio Permissions and Context MUST be requested directly in user gesture
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 16000
        } 
      });
      streamRef.current = stream;

      const inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ 
        sampleRate: 16000,
        latencyHint: 'interactive'
      });
      const outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ 
        sampleRate: 24000,
        latencyHint: 'interactive'
      });

      // Resume context to ensure audio starts (needed for some browsers)
      await inputAudioContext.resume();
      await outputAudioContext.resume();
      
      inputAudioCtxRef.current = inputAudioContext;
      outputAudioCtxRef.current = outputAudioContext;

      const inputAnalyser = inputAudioContext.createAnalyser();
      inputAnalyser.fftSize = 256;
      inputAnalyserRef.current = inputAnalyser;

      const outputAnalyser = outputAudioContext.createAnalyser();
      outputAnalyser.fftSize = 256;
      outputAnalyserRef.current = outputAnalyser;

      const source = inputAudioContext.createMediaStreamSource(stream);
      const scriptProcessor = inputAudioContext.createScriptProcessor(512, 1, 1);
      
      scriptProcessor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const pcmBlob = createBlob(inputData);
        if (sessionRef.current) {
          sessionRef.current.sendRealtimeInput({ media: pcmBlob });
        }
      };

      source.connect(inputAnalyser);
      inputAnalyser.connect(scriptProcessor);
      scriptProcessor.connect(inputAudioContext.destination);

      // 2. Connect to API
      const ai = new GoogleGenAI({
        apiKey: import.meta.env.VITE_GEMINI_API_KEY});
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            setIsConnecting(false);
            setIsCalling(true);
            // Proactive greeting trigger
            if (sessionRef.current) {
              sessionRef.current.sendRealtimeInput({ text: "START_GREETING_NOW" });
            }
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioCtxRef.current) {
              const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioCtxRef.current, 24000, 1);
              const source = outputAudioCtxRef.current.createBufferSource();
              source.buffer = audioBuffer;
              
              const gainNode = outputAudioCtxRef.current.createGain();
              source.connect(gainNode);
              gainNode.connect(outputAnalyserRef.current!);
              outputAnalyserRef.current!.connect(outputAudioCtxRef.current.destination);
              
              const now = outputAudioCtxRef.current.currentTime;
              if (nextStartTimeRef.current < now) {
                nextStartTimeRef.current = now;
              }
              
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
              source.onended = () => sourcesRef.current.delete(source);
            }

            if (message.serverContent?.interrupted && outputAudioCtxRef.current) {
              sourcesRef.current.forEach(s => { 
                try { s.stop(); } catch(e) {} 
              });
              sourcesRef.current.clear();
              nextStartTimeRef.current = outputAudioCtxRef.current.currentTime;
            }

            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              currentInputRef.current += text;
              setCurrentInput(currentInputRef.current);
            }

            if (message.serverContent?.outputTranscription) {
              const text = message.serverContent.outputTranscription.text;
              currentOutputRef.current += text;
              setCurrentOutput(currentOutputRef.current);
            }

            // --- THIS IS THE UPDATED LOGIC FOR SENDING DATA TO BACKEND ---
            if (message.serverContent?.turnComplete) {
              const userText = currentInputRef.current.trim();
              const officerText = currentOutputRef.current.trim();
              
              if (userText || officerText) {
                setTranscripts(prev => {
                  const newItems: TranscriptionItem[] = [];
                  if (userText) newItems.push({ role: 'user', text: userText, timestamp: Date.now() });
                  if (officerText) newItems.push({ role: 'officer', text: officerText, timestamp: Date.now() });
                  return [...prev, ...newItems];
                });

                // 1. DETECT JSON DATA (Hidden Block from AI)
                const jsonMatch = officerText.match(/```json\n([\s\S]*?)\n```/);
                if (jsonMatch && jsonMatch[1]) {
                  try {
                    const complaintData = JSON.parse(jsonMatch[1]);
                    console.log("Extracted JSON:", complaintData);
                    await sendComplaintToBackend(complaintData);// DO NOT close yet — let audio finish
                    } catch (e) {
                      console.error("JSON parse failed:", e);
                    }
                  }
                // 4. Fallback: Close call if "complaint number" is mentioned but no JSON found
                const endPhraseRegex = /(शिकायत संख्या है \d{4}|complaint number is \d{4})/i;
                if (endPhraseRegex.test(officerText) && !isClosing) {
                   autoEndTimerRef.current = window.setTimeout(() => {
                    cleanup(true);
                  }, 5000);
                }
              }

              currentInputRef.current = '';
              currentOutputRef.current = '';
              setCurrentInput('');
              setCurrentOutput('');
            }
          },
          onerror: (e) => {
            console.error('API Error:', e);
            setError('SIGNAL INTERRUPTION');
            cleanup();
          },
          onclose: () => cleanup()
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION + "\nRespond with EXTREME URGENCY. Minimize Turn-Taking Latency. Do not wait for long pauses. If the text input is 'START_GREETING_NOW', immediately speak the mandatory bilingual greeting.",
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          },
          thinkingConfig: { thinkingBudget: 256 },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });
      
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error('Call Error:', err);
      setError('INITIALIZATION FAILED. PLEASE CHECK MIC PERMISSIONS.');
      cleanup();
    }
  };

  return (
    <div className="h-screen w-screen flex flex-col relative overflow-hidden bg-neural">
      <header className="h-16 lg:h-20 shrink-0 flex items-center justify-between px-6 lg:px-20 border-b border-white/5 relative z-10 bg-black/20 backdrop-blur-xl">
        <div className="flex items-center space-x-3 lg:space-x-5">
          <div className="w-8 h-8 lg:w-10 lg:h-10 rounded-lg lg:rounded-xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20">
            <svg className="w-4 h-4 lg:w-5 lg:h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04l.054-.09A13.916 13.916 0 008 11a4 4 0 118 0c0 1.017-.07 2.019-.203 3m-2.118 6.844A21.88 21.88 0 0015.171 17m3.839 1.132c.645-2.266.99-4.659.99-7.132A8 8 0 008 4.07M3 15.364c.64-1.319 1-2.8 1-4.364 0-1.457.39-2.823 1.07-4" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm lg:text-lg font-bold tracking-tight uppercase text-white leading-tight">{ORGANIZATION}</h1>
            <p className="text-[7px] lg:text-[9px] mono text-slate-500 font-bold uppercase tracking-[0.2em] lg:tracking-[0.4em]">Digital Redressal Hub</p>
          </div>
        </div>
        
        <div className="flex items-center space-x-4 lg:space-x-12">
          <div className="hidden md:block text-right">
            <p className="text-xs font-black text-indigo-400 uppercase tracking-[0.1em]">{OFFICER_NAME}</p>
            <p className="text-[9px] mono text-slate-600 uppercase font-bold">
              Status: {isConnecting ? 'CONNECTING...' : isClosing ? 'FINALIZING...' : isCalling ? 'ON CALL' : 'STANDBY'}
            </p>
          </div>
          <div className={`w-2.5 h-2.5 lg:w-3 lg:h-3 rounded-full transition-all duration-700 ${isConnecting || isClosing ? 'bg-amber-500 animate-pulse' : isCalling ? 'bg-cyan-500 shadow-[0_0_15px_#22d3ee] animate-pulse' : 'bg-slate-700'}`}></div>
        </div>
      </header>

      <main className="flex-grow flex flex-col lg:flex-row p-4 lg:p-10 gap-4 lg:gap-10 relative z-10 overflow-hidden min-h-0">
        <div className="w-full lg:w-[400px] flex flex-col items-center justify-center shrink-0 lg:h-full lg:overflow-y-auto custom-scrollbar">
          <div className="text-center mb-6 lg:mb-12 space-y-1 lg:space-y-4">
            <h2 className="text-xl lg:text-3xl font-bold tracking-tight text-white uppercase italic">
              {isClosing ? 'Closing Connection' : isCalling ? 'Active Link' : isConnecting ? 'Establishing...' : 'Delhi Sudarshan'}
            </h2>
            <div className="flex items-center justify-center space-x-2">
                <span className="w-1 h-1 lg:w-1.5 lg:h-1.5 rounded-full bg-slate-700"></span>
                <p className="text-[8px] lg:text-[10px] mono text-slate-600 font-bold uppercase tracking-[0.3em]">Terminal #011</p>
            </div>
          </div>

          <div className="relative mb-6 lg:mb-12">
            <button
              onClick={handleCall}
              disabled={isClosing}
              className={`w-32 h-32 lg:w-44 lg:h-44 rounded-full flex flex-col items-center justify-center floating-orb transition-all duration-300 ${
                isClosing ? 'bg-amber-600/50 cursor-not-allowed' : isCalling ? 'bg-red-600 animate-pulse pulse-active' : isConnecting ? 'bg-amber-600 animate-pulse' : 'bg-indigo-600'
              }`}
            >
              {isConnecting ? (
                <div className="flex flex-col items-center text-white">
                  <svg className="w-10 h-10 lg:w-14 lg:h-14 mb-1 animate-spin" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <span className="text-[7px] lg:text-[9px] mono uppercase font-black tracking-widest">Linking</span>
                </div>
              ) : isClosing ? (
                <div className="flex flex-col items-center text-white">
                  <svg className="w-10 h-10 lg:w-14 lg:h-14 mb-1 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span className="text-[7px] lg:text-[9px] mono uppercase font-black tracking-widest">Done</span>
                </div>
              ) : isCalling ? (
                <div className="flex flex-col items-center text-white">
                  <svg className="w-10 h-10 lg:w-14 lg:h-14 mb-1 lg:mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  <span className="text-[7px] lg:text-[9px] mono uppercase font-black tracking-widest opacity-60">End Call</span>
                </div>
              ) : (
                <div className="flex flex-col items-center text-white">
                  <svg className="w-10 h-10 lg:w-14 lg:h-14 mb-1 lg:mb-2" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M20 15.5c-1.2 0-2.4-.2-3.6-.6-.3-.1-.7 0-1 .2l-2.2 2.2c-2.8-1.4-5.1-3.8-6.6-6.6l2.2-2.2c.3-.3.4-.7.2-1-.3-1.1-.5-2.3-.5-3.5 0-.6-.4-1-1-1H4c-.6 0-1 .4-1 1 0 9.4 7.6 17 17 17 .6 0 1-.4 1-1v-3.5c0-.6-.4-1-1-1z" />
                  </svg>
                  <span className="text-[8px] lg:text-[10px] mono uppercase font-black tracking-[0.3em] opacity-90">Call</span>
                </div>
              )}
            </button>
          </div>

          <div className={`w-full max-w-[280px] lg:max-w-[300px] space-y-4 lg:space-y-10 transition-all duration-1000 ${isCalling ? 'opacity-100 translate-y-0' : 'opacity-20 translate-y-4 lg:translate-y-8'}`}>
            <div className="space-y-1.5 lg:space-y-3">
              <div className="flex justify-between items-center px-1">
                <span className="text-[7px] lg:text-[9px] mono text-cyan-500 font-bold uppercase tracking-widest">Citizen Input</span>
                <span className="text-[6px] lg:text-[8px] mono text-slate-700 font-bold uppercase">RX Live</span>
              </div>
              <div className="glass-panel p-1 lg:p-2 rounded-xl lg:rounded-2xl overflow-hidden">
                <Visualizer analyser={inputAnalyserRef.current} isActive={isCalling} color="#22d3ee" gradientStart="#22d3ee" gradientEnd="#06b6d4" />
              </div>
            </div>
            <div className="space-y-1.5 lg:space-y-3">
              <div className="flex justify-between items-center px-1">
                <span className="text-[7px] lg:text-[9px] mono text-indigo-400 font-bold uppercase tracking-widest">Officer Bus</span>
                <span className="text-[6px] lg:text-[8px] mono text-slate-700 font-bold uppercase">TX Encoded</span>
              </div>
              <div className="glass-panel p-1 lg:p-2 rounded-xl lg:rounded-2xl overflow-hidden">
                <Visualizer analyser={outputAnalyserRef.current} isActive={isCalling} color="#818cf8" gradientStart="#818cf8" gradientEnd="#6366f1" />
              </div>
            </div>
          </div>
          
          {error && (
            <div className="mt-4 lg:mt-8 px-6 py-2 lg:py-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-center animate-slide-up">
              <p className="text-[8px] lg:text-[10px] mono font-bold uppercase tracking-widest italic">{error}</p>
            </div>
          )}

          {transcripts.length > 0 && (
            <button 
              onClick={() => setTranscripts([])}
              className="mt-6 text-[8px] lg:text-[10px] mono text-slate-700 hover:text-red-400 uppercase tracking-widest transition-colors"
            >
              [ CLEAR SESSION DATA ]
            </button>
          )}
        </div>

        <div className="flex-grow flex flex-col min-h-0 min-w-0">
          <div className="glass-panel rounded-[2rem] lg:rounded-[3rem] flex flex-col h-full overflow-hidden shadow-2xl relative">
            <div className="px-6 lg:px-12 py-4 lg:py-8 border-b border-white/5 flex items-center justify-between bg-white/5 shrink-0">
              <div className="flex items-center space-x-3 lg:space-x-6">
                <div className="flex space-x-1 lg:space-x-1.5">
                  <div className="w-1.5 h-1.5 lg:w-2 lg:h-2 rounded-full bg-slate-700"></div>
                  <div className="w-1.5 h-1.5 lg:w-2 lg:h-2 rounded-full bg-slate-700"></div>
                  <div className="w-1.5 h-1.5 lg:w-2 lg:h-2 rounded-full bg-slate-700"></div>
                </div>
                <h3 className="text-[9px] lg:text-[11px] mono font-bold uppercase tracking-[0.2em] lg:tracking-[0.5em] text-slate-500">Live Transmission Log</h3>
              </div>
              <div className="flex items-center space-x-2 lg:space-x-3 text-[7px] lg:text-[9px] mono text-slate-700 font-bold uppercase">
                <span className={isCalling ? "text-green-500 animate-pulse" : ""}>●</span>
                <span>Node S01</span>
              </div>
            </div>

            <div 
              ref={scrollRef}
              className="flex-grow overflow-y-auto p-6 lg:p-14 space-y-6 lg:space-y-10 custom-scrollbar relative min-h-0"
            >
              {!isCalling && !isConnecting && transcripts.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center opacity-10 grayscale">
                  <svg className="w-16 h-16 lg:w-24 lg:h-24 mb-4 lg:mb-6 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  <p className="text-xs lg:text-sm mono uppercase tracking-[0.4em] lg:tracking-[0.8em] font-black text-center">Awaiting Handshake</p>
                </div>
              ) : (
                <div className="flex flex-col space-y-6 lg:space-y-8 max-w-4xl mx-auto">
                  {transcripts.map((t, i) => (
                    <div 
                      key={i} 
                      className={`flex ${t.role === 'user' ? 'justify-end' : 'justify-start'} animate-slide-up`}
                    >
                      <div className={`relative max-w-[92%] px-6 py-4 lg:px-10 lg:py-7 rounded-[1.5rem] lg:rounded-[2.5rem] border transition-all duration-500 ${
                        t.role === 'user' 
                        ? 'bg-indigo-500/5 text-indigo-100 border-indigo-500/20 rounded-tr-none' 
                        : 'bg-white/[0.03] text-slate-200 border-white/10 rounded-tl-none shadow-lg'
                      }`}>
                        <div className="flex items-center justify-between mb-3 lg:mb-4">
                          <div className="flex items-center space-x-2 lg:space-x-4">
                            <div className={`w-1.5 h-1.5 lg:w-2 lg:h-2 rounded-full ${t.role === 'user' ? 'bg-cyan-500 shadow-[0_0_8px_#22d3ee]' : 'bg-indigo-500 shadow-[0_0_8px_#6366f1]'}`}></div>
                            <p className={`text-[8px] lg:text-[10px] mono font-black uppercase tracking-[0.1em] lg:tracking-[0.2em] ${
                              t.role === 'user' ? 'text-cyan-500' : 'text-indigo-400'
                            }`}>
                              {t.role === 'user' ? 'Citizen' : 'Officer Rajesh Kumar'}
                            </p>
                          </div>
                          <span className="text-[7px] lg:text-[9px] mono text-slate-700 font-bold italic">
                            {new Date(t.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        <p className="text-sm lg:text-lg leading-relaxed font-medium text-white/90 whitespace-pre-wrap">{t.text}</p>
                      </div>
                    </div>
                  ))}

                  {currentInput && (
                    <div className="flex justify-end opacity-40 animate-pulse">
                      <div className="max-w-[92%] px-6 py-4 lg:px-10 lg:py-7 rounded-[1.5rem] lg:rounded-[2.5rem] bg-indigo-500/5 text-indigo-100 italic border border-white/5 rounded-tr-none">
                        <p className="text-sm lg:text-lg leading-relaxed">{currentInput}</p>
                      </div>
                    </div>
                  )}

                  {currentOutput && (
                    <div className="flex justify-start">
                      <div className="max-w-[92%] px-6 py-4 lg:px-10 lg:py-7 rounded-[1.5rem] lg:rounded-[2.5rem] bg-indigo-500/5 text-indigo-50 border border-white/10 rounded-tl-none">
                        <div className="flex items-center space-x-2 lg:space-x-3 mb-3 lg:mb-4">
                            <div className="w-1 lg:w-1.5 h-1 lg:h-1.5 rounded-full bg-indigo-500 animate-bounce"></div>
                            <span className="text-[7px] lg:text-[9px] mono text-indigo-500/60 uppercase font-bold tracking-widest">Processing...</span>
                        </div>
                        <p className="text-sm lg:text-lg leading-relaxed">{currentOutput}</p>
                      </div>
                    </div>
                  )}
                  <div className="h-4 w-full"></div>
                </div>
              )}
            </div>
            
            <div className="px-6 lg:px-16 py-4 lg:py-8 bg-black/20 border-t border-white/5 flex items-center justify-between backdrop-blur-md shrink-0">
              <div className="flex space-x-6 lg:space-x-12">
                <div className="flex flex-col">
                  <span className="text-[7px] lg:text-[9px] mono text-slate-700 uppercase font-black tracking-widest mb-0.5 lg:mb-1">Data Rate</span>
                  <span className="text-[9px] lg:text-xs mono text-green-500 font-bold tracking-tighter uppercase italic">Live 48kbps</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[7px] lg:text-[9px] mono text-slate-700 uppercase font-black tracking-widest mb-0.5 lg:mb-1">Encryption</span>
                  <span className="text-[9px] lg:text-xs mono text-indigo-500 font-bold uppercase tracking-tighter">AES 256 GCM</span>
                </div>
              </div>
              <div className="hidden lg:block text-right">
                <p className="text-[10px] mono text-slate-800 font-black uppercase tracking-[0.4em]">Redressal Terminal</p>
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="h-10 lg:h-14 shrink-0 flex items-center justify-center border-t border-white/5 bg-black/30 backdrop-blur-md relative z-10">
        <p className="text-[6px] lg:text-[10px] mono text-slate-800 uppercase tracking-[0.4em] lg:tracking-[1em] font-black text-center px-4">
          GOVT OF DELHI CIVIC REDRESSAL DL-SEC-0922
        </p>
      </footer>
    </div>
  );
};

// Helper function to send data to the backend
async function sendComplaintToBackend(complaint: any) {
  try {
    console.log("Sending to backend:", complaint);
    
    // SENDING TO THE RENDER AS BACKEND
    await fetch("https://delhi-sudarshan-backend.onrender.com/api/new-complaint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(complaint)
    });
    
    console.log("Data sent successfully!");
  } catch (error) {
    console.error("Failed to send complaint:", error);
  }
}

export default App;