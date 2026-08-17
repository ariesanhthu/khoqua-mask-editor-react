'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getMe, login, seedDatabase } from '@/lib/api-client';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [seeding, setSeeding] = useState(false);

  // Check if already logged in
  useEffect(() => {
    getMe().then(() => router.replace('/')).catch(() => undefined);
  }, [router]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username, password);
      router.replace('/');
      router.refresh();
    } catch (err: unknown) {
      const apiErr = err as { message?: string };
      setError(apiErr.message || 'Đăng nhập thất bại');
    } finally {
      setLoading(false);
    }
  };

  const handleSeed = async () => {
    setSeeding(true);
    setError('');
    try {
      const result = await seedDatabase();
      setError(`✓ Đã tạo ${result.users} users, ${result.files} files. Đăng nhập: Thư / 123456`);
    } catch (err: unknown) {
      const apiErr = err as { message?: string };
      setError(apiErr.message || 'Seed thất bại');
    } finally {
      setSeeding(false);
    }
  };

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="login-heading">
          <div className="login-logo">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
          <p className="eyebrow">Annotation workspace</p>
          <h1>Bitter Melon Annotation</h1>
          <p>Công cụ kiểm tra mặt nạ và đánh dấu điểm đứt gãy</p>
        </div>

        <form onSubmit={handleLogin} className="login-form">
          <label htmlFor="username">
            <span>Tên đăng nhập</span>
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Ví dụ: Nguyễn An…"
              spellCheck={false}
            />
          </label>

          <label htmlFor="password">
            <span>Mật khẩu</span>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••"
            />
          </label>

          {error && (
            <p role="status" aria-live="polite" className={`login-message ${error.startsWith('✓') ? 'success' : 'error'}`}>
              {error}
            </p>
          )}

          <button
            id="login-btn"
            type="submit"
            disabled={loading || !username || !password}
            className="button primary login-submit"
          >
            {loading ? 'Đang đăng nhập…' : 'Đăng nhập'}
          </button>
        </form>

        {process.env.NODE_ENV === 'development' ? <div className="login-dev-tools">
          <button
            id="seed-btn"
            onClick={handleSeed}
            disabled={seeding}
            className="button ghost"
          >
            {seeding ? 'Đang tạo dữ liệu…' : 'Tạo dữ liệu mẫu (chỉ môi trường dev)'}
          </button>
        </div> : null}
      </section>
    </main>
  );
}
