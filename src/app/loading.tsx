import Image from "next/image";
import Link from "next/link";

export default function Loading() {
  return (
    <main className="route-loading-page" aria-busy="true" aria-label="Загрузка каталога">
      <header className="catalog-header route-loading-header">
        <Link className="premium-brand" href="/" aria-label="На главную"><span className="premium-brand-art"><Image className="premium-brand-mark" src="/assets/logo-header-dark.png" alt="Честный пригон" width={2172} height={724} priority /></span></Link>
        <span className="route-loading-label"><i />Обновляем каталог…</span>
      </header>
      <div className="route-loading-content">
        <div className="route-loading-heading" />
        <div className="route-loading-cards"><span /><span /><span /><span /></div>
      </div>
    </main>
  );
}
