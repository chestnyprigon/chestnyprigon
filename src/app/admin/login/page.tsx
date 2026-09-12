import { login } from "./actions";

export default async function AdminLogin({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  return <main className="admin-login"><form action={login}><p>Честный пригон</p><h1>Вход в заявки</h1><label>Пароль администратора<input name="password" type="password" autoFocus required /></label>{params.error ? <small>Неверный пароль.</small> : null}<button>Войти</button></form></main>;
}
