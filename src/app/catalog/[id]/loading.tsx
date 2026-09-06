export default function VehicleLoading() {
  return (
    <main className="dossier-page" aria-busy="true" aria-label="Загрузка автомобиля">
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
