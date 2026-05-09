import { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { 
  Activity, 
  Play, 
  Square, 
  RotateCcw, 
  RefreshCcw,
  Users, 
  ShieldAlert, 
  Terminal, 
  CheckCircle2, 
  XCircle, 
  Loader2,
  ExternalLink,
  UserMinus
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const DEV_CHANNEL = 'https://whatsapp.com/channel/0029VbANEgU4NVipdhsRvO0f';

export default function App() {
  const [status, setStatus] = useState<'connected' | 'disconnected' | 'connecting'>('disconnected');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [ownerNumber, setOwnerNumber] = useState('');
  const [bannedUsers, setBannedUsers] = useState<Record<string, any>>({});
  const [stats, setStats] = useState({ groups: 0, users: 0, activeBots: 0 });
  const socketRef = useRef<Socket | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const socket = io();
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Socket.io: Connected');
      setStatus('connected');
    });

    socket.on('connect_error', (err) => {
      console.error('Socket.io Connection Error:', err);
      setStatus('disconnected');
    });

    socket.on('disconnect', (reason) => {
      console.log('Socket.io: Disconnected', reason);
      setStatus('disconnected');
    });

    socket.on('status', (s) => setStatus(s));
    socket.on('pairingCode', (c) => setPairingCode(c));
    socket.on('logs', (l) => setLogs(l));
    socket.on('log', (l) => setLogs(prev => [...prev.slice(-99), l]));
    socket.on('stats', (s) => setStats(s));
    socket.on('bannedUsers', (u) => setBannedUsers(u));
    socket.on('ownerNumber', (n) => setOwnerNumber(n));
    socket.on('botNumber', (n) => {
      if (n) setPhoneNumber(n);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const handleStart = () => {
    if (!phoneNumber) {
      alert('من فضلك أدخل رقم الهاتف أولاً');
      return;
    }
    socketRef.current?.emit('startBot', phoneNumber.replace(/[^0-9]/g, ''));
  };

  const handleForcePairing = () => {
    if (!phoneNumber) {
      alert('من فضلك أدخل رقم الهاتف أولاً');
      return;
    }
    if (confirm('هل أنت متأكد أنك تريد مسح الجلسة الحالية وإعادة الربط من جديد؟')) {
      socketRef.current?.emit('forcePairing', phoneNumber.replace(/[^0-9]/g, ''));
    }
  };

  const handleStop = () => socketRef.current?.emit('stopBot');
  const handleRestart = () => socketRef.current?.emit('restartBot');
  const handleUnban = (userId: string) => socketRef.current?.emit('unbanUser', userId);

  return (
    <div className="min-h-screen bg-black text-green-500 font-mono">
      {/* Header */}
      <header className="bg-slate-950 border-b border-green-900 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-green-900 rounded-xl flex items-center justify-center text-green-400 shadow-lg shadow-green-900/50">
              <Activity size={24} />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-green-400">Maro BOT</h1>
              <p className="text-xs text-green-700 font-medium">لوحة التحكم الذكية</p>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <div className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border",
              status === 'connected' ? "bg-green-950 text-emerald-400 border-emerald-900" :
              status === 'connecting' ? "bg-amber-950 text-amber-400 border-amber-900" :
              "bg-rose-950 text-rose-400 border-rose-900"
            )}>
              {status === 'connected' ? <CheckCircle2 size={14} /> : 
               status === 'connecting' ? <Loader2 size={14} className="animate-spin" /> : 
               <XCircle size={14} />}
              {status === 'connected' ? 'متصل' : status === 'connecting' ? 'جاري الاتصال' : 'غير متصل'}
            </div>
            <a 
              href={DEV_CHANNEL} 
              target="_blank" 
              rel="noopener noreferrer"
              className="hidden sm:flex items-center gap-2 text-xs font-medium text-green-700 hover:text-green-400 transition-colors"
            >
              قناة المطور <ExternalLink size={14} />
            </a>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          {/* Left Column: Controls & Pairing */}
          <div className="space-y-8">
            {/* Connection Card */}
            <section className="bg-slate-950 rounded-2xl p-6 shadow-sm border border-green-900">
              <h2 className="text-lg font-bold mb-4 flex items-center gap-2 text-green-400">
                <Play size={20} className="text-green-500" /> التحكم بالبوت
              </h2>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-green-700 mb-1">رقم هاتف البوت (للاتصال)</label>
                  <input 
                    type="text" 
                    placeholder="201094534865"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    disabled={status !== 'disconnected'}
                    className="w-full px-4 py-2 rounded-xl border border-green-900 bg-black text-green-500 focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition-all disabled:bg-slate-900 disabled:text-slate-600"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-green-700 mb-1">رقم المالك (للتحكم بالبوت)</label>
                  <div className="flex gap-2">
                    <input 
                      type="text" 
                      placeholder="201094534865"
                      value={ownerNumber}
                      onChange={(e) => setOwnerNumber(e.target.value)}
                      className="w-full px-4 py-2 rounded-xl border border-green-900 bg-black text-green-500 focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition-all"
                    />
                    <button 
                      onClick={() => socketRef.current?.emit('setOwnerNumber', ownerNumber)}
                      className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-green-500 rounded-xl font-bold transition-all whitespace-nowrap"
                    >
                      حفظ
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <button 
                    onClick={handleStart}
                    disabled={status !== 'disconnected'}
                    className="flex items-center justify-center gap-2 bg-green-900 hover:bg-green-800 disabled:bg-slate-800 text-black py-2.5 rounded-xl font-bold transition-all shadow-md shadow-green-900/20"
                  >
                    <Play size={18} /> تشغيل
                  </button>
                  <button 
                    onClick={handleStop}
                    disabled={status === 'disconnected'}
                    className="flex items-center justify-center gap-2 bg-rose-900 hover:bg-rose-800 disabled:bg-slate-800 text-black py-2.5 rounded-xl font-bold transition-all shadow-md shadow-rose-900/20"
                  >
                    <Square size={18} /> إيقاف
                  </button>
                </div>
                
                <div className="grid grid-cols-2 gap-3">
                  <button 
                    onClick={handleRestart}
                    className="w-full flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 text-green-500 py-2.5 rounded-xl font-bold transition-all"
                  >
                    <RotateCcw size={18} /> إعادة تشغيل
                  </button>
                  <button 
                    onClick={handleForcePairing}
                    disabled={status !== 'disconnected'}
                    className="w-full flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 text-amber-500 py-2.5 rounded-xl font-bold transition-all disabled:opacity-50"
                  >
                    <RefreshCcw size={18} /> إعادة ربط
                  </button>
                </div>
              </div>

              {status === 'connecting' && !pairingCode && (
                <div className="mt-6 p-4 bg-amber-950 rounded-2xl border border-amber-900 text-center">
                  <p className="text-xs font-bold text-amber-500 flex items-center justify-center gap-2">
                    <Loader2 size={14} className="animate-spin" /> جاري طلب الكود من واتساب...
                  </p>
                </div>
              )}

              {pairingCode && (
                <div className="mt-6 p-4 bg-green-950 rounded-2xl border border-green-900 text-center animate-pulse">
                  <p className="text-xs font-bold text-green-500 uppercase tracking-widest mb-2">كود الربط</p>
                  <div className="text-3xl font-mono font-black text-green-400 tracking-widest">
                    {pairingCode}
                  </div>
                  <p className="text-[10px] text-green-700 mt-2">استخدم هذا الكود في "الأجهزة المرتبطة" داخل واتساب</p>
                </div>
              )}
            </section>

            {/* Stats Card */}
            <section className="bg-slate-950 rounded-2xl p-6 shadow-sm border border-green-900">
              <h2 className="text-lg font-bold mb-4 flex items-center gap-2 text-green-400">
                <Users size={20} className="text-green-500" /> إحصائيات سريعة
              </h2>
              <div className="grid grid-cols-3 gap-4">
                <div className="p-4 bg-black rounded-xl border border-green-900">
                  <p className="text-xs text-green-700 font-bold mb-1">المجموعات</p>
                  <p className="text-2xl font-black text-green-400">{stats.groups}</p>
                </div>
                <div className="p-4 bg-black rounded-xl border border-green-900">
                  <p className="text-xs text-green-700 font-bold mb-1">المستخدمين</p>
                  <p className="text-2xl font-black text-green-400">{stats.users}</p>
                </div>
                <div className="p-4 bg-black rounded-xl border border-green-900">
                  <p className="text-xs text-green-700 font-bold mb-1">البوتات النشطة</p>
                  <p className="text-2xl font-black text-green-400">{stats.activeBots}</p>
                </div>
              </div>
            </section>
          </div>

          {/* Middle & Right Column: Logs & Management */}
          <div className="lg:col-span-2 space-y-8">
            {/* Logs Section */}
            <section className="bg-slate-900 rounded-2xl p-6 shadow-xl border border-slate-800 flex flex-col h-[500px]">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <Terminal size={20} className="text-emerald-400" /> سجل العمليات (Logs)
                </h2>
                <div className="flex gap-1">
                  <div className="w-3 h-3 rounded-full bg-rose-500" />
                  <div className="w-3 h-3 rounded-full bg-amber-500" />
                  <div className="w-3 h-3 rounded-full bg-emerald-500" />
                </div>
              </div>
              
              <div className="flex-1 overflow-y-auto font-mono text-sm space-y-1 scrollbar-thin scrollbar-thumb-slate-700 pr-2">
                {logs.length === 0 ? (
                  <p className="text-slate-500 italic">في انتظار العمليات...</p>
                ) : (
                  logs.map((log, i) => (
                    <div key={i} className="text-slate-300 border-l-2 border-slate-700 pl-3 py-0.5 hover:bg-slate-800 transition-colors">
                      {log}
                    </div>
                  ))
                )}
                <div ref={logEndRef} />
              </div>
            </section>

            {/* Banned Users Section */}
            <section className="bg-slate-950 rounded-2xl p-6 shadow-sm border border-green-900">
              <h2 className="text-lg font-bold mb-4 flex items-center gap-2 text-green-400">
                <ShieldAlert size={20} className="text-green-500" /> إدارة المحظورين
              </h2>
              
              <div className="overflow-x-auto">
                <table className="w-full text-right">
                  <thead>
                    <tr className="text-green-700 text-xs border-b border-green-900">
                      <th className="pb-3 font-bold">المستخدم</th>
                      <th className="pb-3 font-bold">النقاط</th>
                      <th className="pb-3 font-bold text-center">الإجراء</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-green-900">
                    {Object.entries(bannedUsers).filter(([_, u]: [string, any]) => u.banned).length === 0 ? (
                      <tr>
                        <td colSpan={3} className="py-8 text-center text-green-800 text-sm">لا يوجد مستخدمين محظورين حالياً</td>
                      </tr>
                    ) : (
                      Object.entries(bannedUsers).filter(([_, u]: [string, any]) => u.banned).map(([id, u]: [string, any]) => (
                        <tr key={id} className="hover:bg-slate-900 transition-colors">
                          <td className="py-3 text-sm font-medium text-green-300">{id.split('@')[0]}</td>
                          <td className="py-3 text-sm text-green-300">{u.points}</td>
                          <td className="py-3 text-center">
                            <button 
                              onClick={() => handleUnban(id)}
                              className="p-2 text-emerald-500 hover:bg-emerald-950 rounded-lg transition-colors"
                              title="فك الحظر"
                            >
                              <UserMinus size={18} />
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </div>
      </main>

      <footer className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 border-t border-green-900 mt-8">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-green-700 text-xs font-medium">
          <p>© 2026 Maro BOT. جميع الحقوق محفوظة.</p>
          <div className="flex items-center gap-6">
            <a href={DEV_CHANNEL} target="_blank" rel="noopener noreferrer" className="hover:text-green-400 transition-colors">قناة المطور</a>
            <p>تم التطوير بواسطة Maro</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
