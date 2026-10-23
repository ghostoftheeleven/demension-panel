import React, { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar';
import { ServerCards } from './components/ServerCards';
import { ClientList } from './components/ClientList';
import { AddServerModal } from './components/AddServerModal';
import { InstallLogsModal } from './components/InstallLogsModal';
import { AwgParamsModal } from './components/AwgParamsModal';
import { AddClientModal } from './components/AddClientModal';
import { QrCodeModal } from './components/QrCodeModal';
import type { Server, Client, QrCodeData } from './types';
import { api } from './api';
import { ShieldCheck, Plus, Terminal, Zap, Sparkles } from 'lucide-react';

export const App: React.FC = () => {
  const [servers, setServers] = useState<Server[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<number | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);

  // Modals state
  const [isAddServerOpen, setIsAddServerOpen] = useState(false);
  const [installModalServer, setInstallModalServer] = useState<Server | null>(null);
  const [paramsModalServer, setParamsModalServer] = useState<Server | null>(null);
  const [isAddClientOpen, setIsAddClientOpen] = useState(false);
  const [qrModalClientId, setQrModalClientId] = useState<number | null>(null);
  const [qrData, setQrData] = useState<QrCodeData | null>(null);

  const loadServers = async () => {
    try {
      const data = await api.getServers();
      setServers(data);
      if (data.length > 0 && selectedServerId === null) {
        setSelectedServerId(data[0].id);
      }
    } catch (err) {
      console.error('Ошибка загрузки серверов:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadClients = async (serverId: number) => {
    try {
      const data = await api.getClients(serverId);
      setClients(data);
    } catch (err) {
      console.error('Ошибка загрузки клиентов:', err);
    }
  };

  useEffect(() => {
    loadServers();
  }, []);

  useEffect(() => {
    if (selectedServerId !== null) {
      loadClients(selectedServerId);
    } else {
      setClients([]);
    }
  }, [selectedServerId]);

  // Periodic polling
  useEffect(() => {
    const interval = setInterval(() => {
      loadServers();
      if (selectedServerId !== null) {
        loadClients(selectedServerId);
      }
    }, 15000);
    return () => clearInterval(interval);
  }, [selectedServerId]);

  const selectedServer = servers.find((s) => s.id === selectedServerId) || null;

  const handleServerAdded = (newServer: Server) => {
    setServers((prev) => [newServer, ...prev]);
    setSelectedServerId(newServer.id);
    // Suggest installing right away
    setInstallModalServer(newServer);
  };

  const handleShowQr = async (clientId: number) => {
    try {
      const data = await api.getClientQr(clientId);
      setQrData(data);
      setQrModalClientId(clientId);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleClientAdded = (newClient: Client) => {
    setClients((prev) => [newClient, ...prev]);
    setServers((prev) =>
      prev.map((s) =>
        s.id === newClient.server_id
          ? { ...s, client_count: (s.client_count || 0) + 1, active_client_count: (s.active_client_count || 0) + 1 }
          : s
      )
    );
    // Immediately open QR code for newly created client!
    handleShowQr(newClient.id);
  };

  const handleClientUpdated = (updated: Client) => {
    setClients((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  };

  const handleClientDeleted = (clientId: number) => {
    setClients((prev) => prev.filter((c) => c.id !== clientId));
    setServers((prev) =>
      prev.map((s) =>
        s.id === selectedServerId
          ? { ...s, client_count: Math.max(0, (s.client_count || 1) - 1) }
          : s
      )
    );
  };

  const handleServerDeleted = (id: number) => {
    const remaining = servers.filter((s) => s.id !== id);
    setServers(remaining);
    setSelectedServerId(remaining.length > 0 ? remaining[0].id : null);
  };

  return (
    <div className="min-h-screen bg-[#090a0f] text-zinc-100 flex flex-col font-sans selection:bg-emerald-500/30 selection:text-emerald-200">
      <Navbar servers={servers} onAddServer={() => setIsAddServerOpen(true)} />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-zinc-500 text-sm">
            Загрузка данных панели...
          </div>
        ) : servers.length === 0 ? (
          /* Empty State / Welcome Screen */
          <div className="max-w-2xl mx-auto text-center py-16 px-6 bg-zinc-900/50 border border-zinc-800/80 rounded-3xl shadow-2xl space-y-6">
            <div className="w-16 h-16 rounded-3xl bg-gradient-to-tr from-emerald-600 to-teal-400 mx-auto flex items-center justify-center shadow-xl shadow-emerald-500/20">
              <ShieldCheck className="w-9 h-9 text-zinc-950 stroke-[2.5]" />
            </div>

            <div className="space-y-2">
              <h2 className="text-2xl font-bold text-white tracking-tight">
                Добро пожаловать в Demension Panel
              </h2>
              <p className="text-sm text-zinc-400 max-w-lg mx-auto">
                Специализированная панель управления для протокола <strong className="text-emerald-400">AmneziaWG</strong>. Добавляйте удаленные серверы по SSH, и панель автоматически развернет изолированный Docker-контейнер и настроит маскировку от DPI.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-left pt-2">
              <div className="p-4 bg-zinc-950/70 border border-zinc-800/80 rounded-2xl">
                <Terminal className="w-5 h-5 text-emerald-400 mb-2" />
                <h4 className="text-xs font-semibold text-white">Agentless по SSH</h4>
                <p className="text-[11px] text-zinc-400 mt-1">Никаких сторонних демонов на сервере — только чистый Docker.</p>
              </div>

              <div className="p-4 bg-zinc-950/70 border border-zinc-800/80 rounded-2xl">
                <Sparkles className="w-5 h-5 text-cyan-400 mb-2" />
                <h4 className="text-xs font-semibold text-white">DPI Bypass</h4>
                <p className="text-[11px] text-zinc-400 mt-1">Автоматическая рандомизация H1..H4, Jc, S1, S2.</p>
              </div>

              <div className="p-4 bg-zinc-950/70 border border-zinc-800/80 rounded-2xl">
                <Zap className="w-5 h-5 text-amber-400 mb-2" />
                <h4 className="text-xs font-semibold text-white">Горячий Syncconf</h4>
                <p className="text-[11px] text-zinc-400 mt-1">Добавление и удаление клиентов без разрыва сессий.</p>
              </div>
            </div>

            <div className="pt-4">
              <button
                onClick={() => setIsAddServerOpen(true)}
                className="inline-flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-medium text-sm px-6 py-3 rounded-2xl transition shadow-xl shadow-emerald-600/25 active:scale-[0.98]"
              >
                <Plus className="w-4 h-4" />
                <span>Добавить первый сервер</span>
              </button>
            </div>
          </div>
        ) : (
          /* Main Workspace */
          <>
            <ServerCards
              servers={servers}
              selectedServerId={selectedServerId}
              onSelectServer={(id) => setSelectedServerId(id)}
              onInstallServer={(s) => setInstallModalServer(s)}
              onEditParams={(s) => setParamsModalServer(s)}
              onServerDeleted={handleServerDeleted}
            />

            {selectedServer && (
              <ClientList
                clients={clients}
                serverName={selectedServer.name}
                serverOnline={selectedServer.status === 'online'}
                onAddClient={() => setIsAddClientOpen(true)}
                onShowQr={handleShowQr}
                onClientUpdated={handleClientUpdated}
                onClientDeleted={handleClientDeleted}
              />
            )}
          </>
        )}
      </main>

      {/* Modals */}
      <AddServerModal
        isOpen={isAddServerOpen}
        onClose={() => setIsAddServerOpen(false)}
        onServerAdded={handleServerAdded}
      />

      <InstallLogsModal
        isOpen={!!installModalServer}
        server={installModalServer}
        onClose={() => setInstallModalServer(null)}
        onFinished={loadServers}
      />

      <AwgParamsModal
        isOpen={!!paramsModalServer}
        server={paramsModalServer}
        onClose={() => setParamsModalServer(null)}
        onUpdated={(updated) => {
          setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        }}
      />

      <AddClientModal
        isOpen={isAddClientOpen}
        serverId={selectedServerId}
        serverName={selectedServer?.name || ''}
        onClose={() => setIsAddClientOpen(false)}
        onClientAdded={handleClientAdded}
      />

      <QrCodeModal
        isOpen={!!qrModalClientId}
        clientId={qrModalClientId}
        qrData={qrData}
        onClose={() => {
          setQrModalClientId(null);
          setQrData(null);
        }}
      />
    </div>
  );
};

export default App;
