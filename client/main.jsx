import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { defaultCompanyDomain } from '../shared/constants.js';
import { Avatar, HeaderBrand } from './Brand.jsx';
import { Login, Profile, roleSummary } from './account.jsx';
import { AuditLog, CatalogEditor, Dashboard, Outbox, Settings, Users, Violations } from './admin.jsx';
import { api, post, useJson } from './api.js';
import { Notifications, ReportIncident, Workload } from './employee.jsx';
import { IncidentBrowser } from './incident-browser.jsx';
import { configureTimeZone, ErrorText, useTask } from './ui.jsx';
import { LiveProvider, useLiveEvents } from './live.js';
import './theme.css';

const roleTabs = {
  EMPLOYEE: ['Report Incident', 'My Incidents', 'Notifications'],
  TECHNICIAN: ['My Incidents', 'My Workload', 'Notifications'],
  ADMINISTRATOR: [
    'Dashboard',
    'Incidents',
    'Users',
    'IT Services',
    'SLA Policies',
    'Categories',
    'SLA Violations',
    'Audit Log',
    'Outbox',
    'Settings',
    'Notifications',
  ],
};
const resources = { 'IT Services': 'services', 'SLA Policies': 'policies', Categories: 'categories' };
const defaultOptions = { demo: false, registration: false, companyDomain: defaultCompanyDomain };
const inboxEvents = ['notification', 'inbox-changed'];
const slug = (name) => name.toLowerCase().replaceAll(' ', '-');
const incidentTabs = new Set(['Incidents', 'My Incidents']);
const readHash = () => window.location.hash;

function subscribeHash(notify) {
  window.addEventListener('hashchange', notify);
  return () => window.removeEventListener('hashchange', notify);
}

function workspaceHash(tab, incident, profile) {
  const params = new URLSearchParams();
  if (profile) params.set('from', slug(tab));
  if (incident && incidentTabs.has(tab)) params.set('incident', incident);
  return '#/' + (profile ? 'profile' : slug(tab)) + (params.size ? '?' + params : '');
}

function workspaceRoute(hash, tabs) {
  const [path, query] = hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(query);
  const profile = path === 'profile';
  const routeTab = profile ? params.get('from') : path;
  const tab = tabs.find((name) => slug(name) === routeTab) || tabs[0];
  const incident = incidentTabs.has(tab) ? params.get('incident') : null;
  return { tab, profile, incident };
}

function setHash(hash, replace = false) {
  if (hash === readHash()) return;
  if (!replace) {
    window.location.hash = hash;
    return;
  }
  window.history.replaceState(window.history.state, '', hash);
  window.dispatchEvent(new Event('hashchange'));
}

function Workspace({ user, options, onUpdate, onLogout }) {
  const tabs = roleTabs[user.role];
  const hash = useSyncExternalStore(subscribeHash, readHash);
  const { tab, profile, incident } = workspaceRoute(hash, tabs);
  const [visited, setVisited] = useState([]);
  const page = useRef(null);
  const task = useTask();
  const live = useLiveEvents();
  const { data: inbox } = useJson('/notifications/unread', { poll: 10000, events: inboxEvents });

  useEffect(() => {
    setHash(workspaceHash(tab, incident, profile), true);
  }, [tab, incident, profile, hash]);
  useEffect(() => {
    if (!profile) setVisited((list) => (list.includes(tab) ? list : [...list, tab]));
    page.current?.scrollTo(0, 0);
  }, [tab, profile]);

  function go(next, id = null, replace = false) {
    setHash(workspaceHash(next, id, false), replace);
  }
  function screen(name, active) {
    switch (name) {
      case 'Report Incident':
        return <ReportIncident active={active} onReported={(id) => go('My Incidents', id)} />;
      case 'Incidents':
      case 'My Incidents':
        return (
          <IncidentBrowser
            user={user}
            active={active}
            selected={active ? incident : null}
            onSelect={(id, replace) => go(name, id, replace)}
          />
        );
      case 'My Workload':
        return <Workload active={active} onUpdate={onUpdate} />;
      case 'Dashboard':
        return <Dashboard active={active} onIncident={(id) => go('Incidents', id)} />;
      case 'Users':
        return <Users active={active} />;
      case 'Audit Log':
        return <AuditLog active={active} />;
      case 'SLA Violations':
        return <Violations active={active} onIncident={(id) => go('Incidents', id)} />;
      case 'Settings':
        return <Settings active={active} demo={options.demo} />;
      case 'Notifications':
        return <Notifications active={active} />;
      case 'Outbox':
        return <Outbox active={active} />;
      default:
        return <CatalogEditor resource={resources[name]} active={active} />;
    }
  }
  return (
    <div className="shell">
      <header className="topbar">
        <HeaderBrand />
        <div className="header-actions">
          <span className="live-state" role="status" data-connected={live.connected}>
            {live.connected ? 'Live' : 'Reconnecting'}
          </span>
          <button
            type="button"
            className="user-chip"
            aria-label={'Open My Profile for ' + user.name}
            onClick={() => setHash(workspaceHash(tab, incident, true))}
          >
            <Avatar name={user.name} />
            <span>
              <strong>{user.name}</strong>
              <small>{roleSummary(user)}</small>
            </span>
          </button>
          <button
            type="button"
            className="light"
            disabled={task.pending}
            onClick={() =>
              task.run(async () => {
                await post('/auth/logout');
                onLogout();
              })
            }
          >
            Logout
          </button>
        </div>
      </header>
      <div className={'workspace' + (profile ? ' profile-workspace' : '')}>
        <nav className="sidebar" aria-label="Workspace menu" hidden={profile}>
          <small className="menu-label">MENU</small>
          {tabs.map((name) => (
            <button
              type="button"
              key={name}
              aria-label={name}
              aria-current={tab === name ? 'page' : undefined}
              onClick={() => go(name)}
              aria-describedby={
                name === 'Notifications' && inbox?.unread > 0 ? 'unread-count' : undefined
              }
            >
              {name}
              {name === 'Notifications' && inbox?.unread > 0 && (
                <>
                  <span className="unread-badge" aria-hidden="true">
                    {inbox.unread}
                  </span>
                  <span id="unread-count" className="sr-only">
                    {inbox.unread} unread
                  </span>
                </>
              )}
            </button>
          ))}
        </nav>
        <main className="page" ref={page}>
          <ErrorText error={task.error} />
          {profile && <Profile user={user} onBack={() => go(tab, incident, true)} onUpdate={onUpdate} />}
          {(visited.includes(tab) ? visited : [...visited, tab]).map((name) => (
            <section
              className={'workspace-tab' + (incidentTabs.has(name) ? ' incident-page' : '')}
              hidden={profile || name !== tab}
              key={name}
            >
              <h1>{name}</h1>
              {screen(name, !profile && tab === name)}
            </section>
          ))}
        </main>
      </div>
      {live.latest && (
        <aside className="notification-toast" role="status">
          <span>{live.latest.subject}</span>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              go('Notifications');
              live.dismiss();
            }}
          >
            View notifications
          </button>
          <button
            type="button"
            className="ghost"
            aria-label="Dismiss notification"
            onClick={live.dismiss}
          >
            ×
          </button>
        </aside>
      )}
    </div>
  );
}

function App() {
  const [user, setUser] = useState(undefined);
  const [options, setOptions] = useState(undefined);
  const [error, setError] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    const ended = () => {
      window.history.replaceState(null, '', '/login' + readHash());
      setUser(null);
    };
    window.addEventListener('nexora-session-ended', ended);
    api('/auth/options', { signal: controller.signal })
      .then((settings) => {
        if (settings.timeZone) configureTimeZone(settings.timeZone);
        setOptions({ ...defaultOptions, ...settings });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setOptions(defaultOptions);
        setError(err);
      });
    api('/auth/me', { signal: controller.signal })
      .then((account) => {
        window.history.replaceState(null, '', '/' + readHash());
        setUser(account);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err.status !== 401) setError(err);
        ended();
      });
    return () => {
      controller.abort();
      window.removeEventListener('nexora-session-ended', ended);
    };
  }, []);
  if (user === undefined || options === undefined)
    return (
      <main className="startup">
        <HeaderBrand />
        <p role="status">Opening Nexora ServiceDesk…</p>
      </main>
    );
  if (!user)
    return (
      <Login
        initialError={error}
        options={options}
        onLogin={(account) => {
          window.history.replaceState(null, '', '/' + readHash());
          setError(null);
          setUser(account);
        }}
      />
    );
  return (
    <LiveProvider key={user.id}>
      <Workspace
        user={user}
        options={options}
        onUpdate={setUser}
        onLogout={() => {
          window.history.replaceState(null, '', '/login');
          setUser(null);
        }}
      />
    </LiveProvider>
  );
}

createRoot(document.getElementById('root')).render(<App />);
