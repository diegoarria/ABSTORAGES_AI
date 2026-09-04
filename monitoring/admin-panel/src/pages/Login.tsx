import { useState, FormEvent } from 'react';
import { api } from '../api';

export default function Login({ onLogin }: { onLogin: (username: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const r = await api.login(username, password);
      onLogin(r.username);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al iniciar sesión');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-box" onSubmit={submit}>
        <h1>Monitoring — ABSTORAGES</h1>
        <input placeholder="Usuario" value={username} onChange={e => setUsername(e.target.value)} autoFocus />
        <input placeholder="Contraseña" type="password" value={password} onChange={e => setPassword(e.target.value)} />
        <button type="submit" disabled={loading}>{loading ? 'Entrando…' : 'Entrar'}</button>
        {error && <div className="error">{error}</div>}
      </form>
    </div>
  );
}
