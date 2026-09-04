import { useEffect, useState } from 'react';
import { HashRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { api } from './api';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import SecurityEvents from './pages/SecurityEvents';
import Incidents from './pages/Incidents';
import Alerts from './pages/Alerts';

export default function App() {
  const [username, setUsername] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    api.me().then(r => setUsername(r.username)).catch(() => setUsername(null)).finally(() => setChecking(false));
  }, []);

  if (checking) return null;
  if (!username) return <Login onLogin={setUsername} />;

  return (
    <HashRouter>
      <div className="layout">
        <nav className="nav">
          <h1>Monitoring</h1>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/security-events">Eventos de seguridad</NavLink>
          <NavLink to="/incidents">Incidentes</NavLink>
          <NavLink to="/alerts">Alertas</NavLink>
          <a className="logout" onClick={() => api.logout().then(() => setUsername(null))}>Cerrar sesión</a>
        </nav>
        <div className="main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/security-events" element={<SecurityEvents />} />
            <Route path="/incidents" element={<Incidents />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </div>
      </div>
    </HashRouter>
  );
}
