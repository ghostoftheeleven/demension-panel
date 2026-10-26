import React, { useState, useEffect, useRef } from 'react';
import { Navbar, type AppTab } from './components/Navbar';
import { SubscriptionSettingsView } from './components/SubscriptionSettingsView';
import { PartnersView } from './components/PartnersView';
import { BridgesView } from './components/BridgesView';
import { ServerCards } from './components/ServerCards';
import { ProbesCard } from './components/ProbesCard';
import { ServersOverview } from './components/ServersOverview';
import { ClientList } from './components/ClientList';
import { SubscribersList } from './components/SubscribersList';
import { SecurityView } from './components/SecurityView';
import { AddServerModal } from './components/AddServerModal';
import { InstallLogsModal } from './components/InstallLogsModal';
import { AwgParamsModal } from './components/AwgParamsModal';
import { AddClientModal } from './components/AddClientModal';
import { AddSubscriberModal } from './components/AddSubscriberModal';
import { SubscriptionModal } from './components/SubscriptionModal';
import { AccountModal } from './components/AccountModal';
import { QrCodeModal } from './components/QrCodeModal';
import { LoginView } from './components/LoginView';
import type { Server, Client, Subscriber, QrCodeData, AdminUser, MigrationStatus } from './types';
import { api } from './api';
import { ShieldCheck, Plus, Terminal, Zap, Sparkles, AlertTriangle } from 'lucide-react';

export const App: React.FC = () => {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [authChecking, setAuthChecking] = useState(true);

  const [activeTab, setActiveTab] = useState<AppTab>('servers');
  const [servers, setServers] = useState<Server[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<number | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [loading, setLoading] = useState(true);

  // Modals state
  const [isAddServerOpen, setIsAddServerOpen] = useState(false);
  const [installModalServer, setInstallModalServer] = useState<Server | null>(null);
  const [paramsModalServer, setParamsModalServer] = useState<Server | null>(null);
  const [isAddClientOpen, setIsAddClientOpen] = useState(false);
  const [qrModalClientId, setQrModalClientId] = useState<number | null>(null);
  const [qrData, setQrData] = useState<QrCodeData | null>(null);

  // Subscriber modals
  const [isAddSubscriberOpen, setIsAddSubscriberOpen] = useState(false);
  const [editingSubscriber, setEditingSubscriber] = useState<Subscriber | null>(null);
  const [subscriptionModalSubId, setSubscriptionModalSubId] = useState<number | null>(null);
  const [editingServer, setEditingServer] = useState<Server | null>(null);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  // Номер последнего запроса клиентов: ответ для ранее выбранного сервера отбрасывается
  const clientsRequestRef = useRef(0);
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [migrationState, setMigrationState] = useState<MigrationStatus['state']>('idle');

  // Check auth on mount
  useEffect(() => {
    api.me()
      .then((res) => {
        setUser(res.user);
      })
      .catch(() => {
        setUser(null);
      })
      .finally(() => {
        setAuthChecking(false);
      });

    const handleUnauthorized = () => {
      setUser(null);
    };
    window.addEventListener('auth_unauthorized', handleUnauthorized);
    return () => window.removeEventListener('auth_unauthorized', handleUnauthorized);
  }, []);

  const loadData = async () => {
    if (!user) return;
    try {
      const [serversData, subscribersData, settings, migration] = await Promise.all([
        api.getServers(),
        api.getSubscribers(),
        api.getSettings().catch(() => null),
        api.getMigrationStatus().catch(() => null),
      ]);
      if (migration) setMigrationState(migration.state);
      setServers(serversData);
      setSubscribers(subscribersData);
      if (settings) setPublicUrl(settings.public_url || null);
      setSelectedServerId((current) =>
        current !== null && serversData.some((s) => s.id === current) ? current : serversData[0]?.id ?? null
      );
    } catch (err) {
      console.error('Ошибка загрузки данных:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadClients = async (serverId: number) => {
    const requestId = ++clientsRequestRef.current;
    try {
      const data = await api.getClients(serverId);
      if (requestId === clientsRequestRef.current) setClients(data);
    } catch (err) {
      console.error('Ошибка загрузки клиентов:', err);
    }
  };

  const loadersRef = useRef({ loadData, loadClients });
  useEffect(() => {
    loadersRef.current = { loadData, loadClients };
  });

  useEffect(() => {
    if (user) {
      loadersRef.current.loadData();
    }
  }, [user]);

  useEffect(() => {
    if (selectedServerId !== null && user) {
      loadersRef.current.loadClients(selectedServerId);
    }
  }, [selectedServerId, user]);

  // Periodic polling (every 15 seconds)
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(() => {
      loadersRef.current.loadData();
      if (selectedServerId !== null) {
        loadersRef.current.loadClients(selectedServerId);
      }
    }, 15000);
    return () => clearInterval(interval);
  }, [selectedServerId, user]);

  if (authChecking) {
    return (
      <div className="min-h-screen bg-page flex items-center justify-center text-faint text-sm">
        Загрузка панели...
      </div>
    );
  }

  if (!user) {
    return <LoginView onLoginSuccess={(loggedInUser) => setUser(loggedInUser)} />;
  }

  const selectedServer = servers.find((s) => s.id === selectedServerId) || null;
  const subscriptionModalSub = subscribers.find((s) => s.id === subscriptionModalSubId) || null;

  // Перед установкой сервер сканируется: если AmneziaWG уже стоит (панели или приложения Amnezia),
  // он подключается без переустановки
  const handleServerAdded = async (newServer: Server) => {
    setServers((prev) => [newServer, ...prev]);
    setSelectedServerId(newServer.id);
    try {
      const scan = await api.scanServer(newServer.id);
      if (scan.found) {
        handleServerUpdated(scan.server);
        loadData();
        const amneziaNote =
          scan.adopted?.managedBy === 'amnezia'
            ? '\n\nЭто контейнер приложения Amnezia: не меняйте клиентов этого сервера в приложении Amnezia — панель перезапишет конфигурацию.'
            : '';
        alert(scan.message + amneziaNote);
        return;
      }
    } catch (err: any) {
      alert(`Не удалось просканировать сервер: ${err.message}\n\nПроверьте SSH-доступ («Тест SSH») и запустите установку вручную.`);
      return;
    }
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
    // Конфигурации ещё нет, пока панель владельца не выдала IP клиенту на ноде партнёра (сервер ответил бы 409)
    if (!newClient.pending && !newClient.external && !newClient.partner_id) handleShowQr(newClient.id);
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
    // Клиенты удалённого сервера пропали и из подписок
    loadData();
  };

  const handleServerUpdated = (updated: Server) => {
    setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
  };

  return (
    <div className="min-h-screen bg-page text-ink flex flex-col font-sans selection:bg-ok-soft selection:text-ok">
      <Navbar
        servers={servers}
        user={user}
        activeTab={activeTab}
        onSelectTab={(tab) => setActiveTab(tab)}
        onAddServer={() => setIsAddServerOpen(true)}
        onAddSubscriber={() => {
          setEditingSubscriber(null);
          setIsAddSubscriberOpen(true);
        }}
        onOpenAccount={() => setIsAccountOpen(true)}
        onLogout={async () => {
          await api.logout();
          setUser(null);
        }}
      />

      {migrationState === 'exporting' && (
        <div className="bg-warn-soft border-b border-line text-warn text-xs">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex flex-wrap items-center gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>
              Идёт перенос панели на другой сервер: изменения сейчас не сохраняются, опрос нод приостановлен.
            </span>
            <button onClick={() => setActiveTab('security')} className="underline hover:text-ink">
              Завершить или отменить перенос
            </button>
          </div>
        </div>
      )}

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-faint text-sm">
            Загрузка данных...
          </div>
        ) : activeTab === 'bridges' ? (
          <BridgesView servers={servers} />
        ) : activeTab === 'partners' ? (
          <PartnersView servers={servers} publicUrl={publicUrl} onChanged={loadData} />
        ) : activeTab === 'subscription' ? (
          <SubscriptionSettingsView subscribers={subscribers} publicUrl={publicUrl} />
        ) : activeTab === 'security' ? (
          /* Security: HTTPS & Fail2ban Tab */
          <SecurityView
            publicUrl={publicUrl}
            onSettingsSaved={(settings) => setPublicUrl(settings.public_url || null)}
            onMigrationChange={loadData}
          />
        ) : activeTab === 'subscribers' ? (
          /* Subscribers & Multi-Node Subscriptions Tab */
          <SubscribersList
            subscribers={subscribers}
            onAddSubscriber={() => {
              setEditingSubscriber(null);
              setIsAddSubscriberOpen(true);
            }}
            onEditSubscriber={(sub) => {
              setEditingSubscriber(sub);
              setIsAddSubscriberOpen(true);
            }}
            onShowSubscription={(sub) => setSubscriptionModalSubId(sub.id)}
            onSubscriberUpdated={(updated) => {
              setSubscribers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
            }}
            onSubscriberDeleted={(id) => {
              setSubscribers((prev) => prev.filter((s) => s.id !== id));
            }}
          />
        ) : servers.length === 0 ? (
          /* Empty Servers Screen */
          <div className="max-w-2xl mx-auto text-center py-16 px-6 bg-card border border-line rounded-2xl shadow-pop space-y-6">
            <div className="w-16 h-16 rounded-2xl bg-mint mx-auto flex items-center justify-center shadow-pop">
              <ShieldCheck className="w-9 h-9 text-on-accent stroke-[2.5]" />
            </div>

            <div className="space-y-2">
              <h2 className="text-2xl font-bold text-ink tracking-tight">
                Добро пожаловать в Dementia Panel
              </h2>
              <p className="text-sm text-muted max-w-lg mx-auto">
                Добавляйте удаленные серверы по SSH, и панель автоматически развернет изолированный Docker-контейнер с AmneziaWG и сгенерирует подписки для клиентов.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-left pt-2">
              <div className="p-4 bg-paper border border-line rounded-2xl">
                <Terminal className="w-5 h-5 text-ok mb-2" />
                <h4 className="text-xs font-semibold text-ink">Agentless по SSH</h4>
                <p className="text-[11px] text-muted mt-1">Никаких сторонних демонов на сервере — только чистый Docker.</p>
              </div>

              <div className="p-4 bg-paper border border-line rounded-2xl">
                <Sparkles className="w-5 h-5 text-info mb-2" />
                <h4 className="text-xs font-semibold text-ink">Параметры протокола</h4>
                <p className="text-[11px] text-muted mt-1">Случайные параметры AmneziaWG (Jc, S1–S4, H1–H4) для каждого сервера.</p>
              </div>

              <div className="p-4 bg-paper border border-line rounded-2xl">
                <Zap className="w-5 h-5 text-warn mb-2" />
                <h4 className="text-xs font-semibold text-ink">Подписки HAPP / Incy</h4>
                <p className="text-[11px] text-muted mt-1">Автообновление списка серверов без ручной настройки.</p>
              </div>
            </div>

            <div className="pt-4">
              <button
                onClick={() => setIsAddServerOpen(true)}
                className="inline-flex items-center gap-2 bg-mint text-on-accent font-bold text-sm px-6 py-3 rounded-2xl transition border border-line btn-press"
              >
                <Plus className="w-4 h-4" />
                <span>Добавить первый сервер</span>
              </button>
            </div>
          </div>
        ) : (
          /* Servers & Clients View */
          <>
            <ServersOverview servers={servers} />

            <ProbesCard onChanged={loadData} />

            <ServerCards
              servers={servers}
              selectedServerId={selectedServerId}
              onSelectServer={(id) => {
                if (id !== selectedServerId) setClients([]);
                setSelectedServerId(id);
              }}
              onInstallServer={(s) => setInstallModalServer(s)}
              onEditParams={(s) => setParamsModalServer(s)}
              onServerDeleted={handleServerDeleted}
              onEditServer={(s) => setEditingServer(s)}
              onServerChanged={loadData}
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
        isOpen={isAddServerOpen || !!editingServer}
        editingServer={editingServer}
        onClose={() => {
          setIsAddServerOpen(false);
          setEditingServer(null);
        }}
        onServerAdded={handleServerAdded}
        onServerUpdated={handleServerUpdated}
        onImported={loadData}
      />

      <InstallLogsModal
        isOpen={!!installModalServer}
        server={installModalServer}
        onClose={() => setInstallModalServer(null)}
        onFinished={loadData}
      />

      <AwgParamsModal
        isOpen={!!paramsModalServer}
        server={paramsModalServer}
        onClose={() => setParamsModalServer(null)}
        onUpdated={handleServerUpdated}
      />

      <AddClientModal
        isOpen={isAddClientOpen}
        serverId={selectedServerId}
        serverName={selectedServer?.name || ''}
        onClose={() => setIsAddClientOpen(false)}
        onClientAdded={handleClientAdded}
      />

      <AddSubscriberModal
        isOpen={isAddSubscriberOpen}
        servers={servers}
        editingSubscriber={editingSubscriber}
        onClose={() => setIsAddSubscriberOpen(false)}
        onSaved={() => loadData()}
      />

      <SubscriptionModal
        isOpen={!!subscriptionModalSub}
        subscriber={subscriptionModalSub}
        publicUrl={publicUrl}
        onClose={() => setSubscriptionModalSubId(null)}
        onTokenReset={(updated) => {
          setSubscribers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        }}
      />

      <AccountModal
        isOpen={isAccountOpen}
        user={user}
        onClose={() => setIsAccountOpen(false)}
        onUsernameChanged={(updated) => setUser(updated)}
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
