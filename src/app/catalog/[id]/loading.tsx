import Image from "next/image";
import Link from "next/link";

export default function VehicleLoading() {
  return (
    <main className="dossier-page route-loading-page" aria-busy="true" aria-label="Загрузка автомобиля">
      <header className="catalog-header route-loading-header">
        <Link className="premium-brand" href="/" aria-label="На главную"><span className="premium-brand-art"><Image className="premium-brand-mark" src="/assets/logo-header-dark.png" alt="Честный пригон" width={2172} height={724} priority /></span></Link>
        <span className="route-loading-label"><i />Открываем карточку автомобиля…</span>
      </header>
      <div className="dossier-shell dossier-loading-shell">
        <div className="dossier-loading-title" />
        <div className="dossier-loading-grid">
          <div className="dossier-loading-photo" />
          <div className="dossier-loading-summary" />
        </div>
      </div>
    </main>
  );
}
