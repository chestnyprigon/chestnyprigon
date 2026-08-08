"use client";

import { useMemo, useState } from "react";
import Image from "next/image";

type DemoCar = { id: string; title: string; year: number; mileage: string; engine: string; price: string; status: string; image: string };

const demoCars: DemoCar[] = [
  { id: "demo-1", title: "Genesis GV70 2.5T", year: 2023, mileage: "28 400 км", engine: "2.5 л · бензин · AWD", price: "$ 32 900", status: "Проверено", image: "/assets/catalog/genesis.svg" },
  { id: "demo-2", title: "Kia Sorento Signature", year: 2022, mileage: "41 200 км", engine: "2.2 л · дизель · AWD", price: "$ 24 700", status: "В наличии", image: "/assets/catalog/kia.svg" },
  { id: "demo-3", title: "Hyundai Palisade Calligraphy", year: 2024, mileage: "16 850 км", engine: "2.5 л · бензин · AWD", price: "$ 41 300", status: "Новый лот", image: "/assets/catalog/hyundai.svg" },
];

export function CatalogPreview() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<DemoCar | null>(null);
  const visible = useMemo(() => demoCars.filter((car) => car.title.toLowerCase().includes(query.toLowerCase())), [query]);

  return <div className="catalog-preview">
    <div className="catalog-toolbar"><label className="catalog-search"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Марка или модель" aria-label="Поиск по каталогу" /></label><button className="catalog-filter" type="button">Все автомобили <span>⌄</span></button><span className="catalog-count">{visible.length} из 2 577 предложений</span></div>
    <div className="catalog-cards">{visible.map((car) => <article className="catalog-card" key={car.id}><div className="catalog-card-media"><Image src={car.image} alt="" fill sizes="(max-width: 720px) 100vw, 33vw" /><span>{car.status}</span></div><div className="catalog-card-body"><p className="catalog-card-source">КОРЕЯ · ENCAR</p><h3>{car.title}</h3><p className="catalog-card-specs">{car.year} · {car.mileage}<br />{car.engine}</p><div className="catalog-card-footer"><strong>{car.price}</strong><button type="button" onClick={() => setSelected(car)}>Подробнее <span>↗</span></button></div></div></article>)}</div>
    {!visible.length && <div className="catalog-empty">По этому запросу ничего не найдено.</div>}
    {selected && <div className="catalog-modal-backdrop" role="presentation" onClick={() => setSelected(null)}><div className="catalog-modal" role="dialog" aria-modal="true" aria-labelledby="catalog-modal-title" onClick={(event) => event.stopPropagation()}><button className="modal-close" type="button" onClick={() => setSelected(null)} aria-label="Закрыть">×</button><p className="eyebrow">Автомобиль из Кореи</p><h3 id="catalog-modal-title">{selected.title}</h3><p>{selected.year} · {selected.mileage} · {selected.engine}</p><strong>{selected.price}</strong><a className="button button-primary" href="#contacts" onClick={() => setSelected(null)}>Запросить расчёт <span>↗</span></a></div></div>}
  </div>;
}
