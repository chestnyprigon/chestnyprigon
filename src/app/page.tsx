import { CatalogPreview } from "@/components/catalog/CatalogPreview";

export default function Home() {
  const steps = [
    ["Консультация", "Уточняем марку, бюджет и сроки."],
    ["Подбор", "Находим варианты, которые подходят именно вам."],
    ["Проверка", "Проверяем историю, пробег и состояние."],
    ["Расчёт", "Показываем итоговую стоимость в USD."],
    ["Покупка", "Сопровождаем сделку и оплату."],
    ["Доставка", "Фиксируем путь автомобиля фото и видео."],
    ["Растаможка", "Помогаем с документами и оформлением."],
    ["Выдача", "Передаём автомобиль и остаёмся на связи."],
  ];

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Честный пригон">
          <span className="brand-mark">✓</span>
          <span><strong>ЧЕСТНЫЙ <em>ПРИГОН</em></strong><small>Автомобили из Кореи в Беларусь</small></span>
        </a>
        <nav aria-label="Основная навигация">
          <a href="#about">О компании</a><a href="#process">Как работаем</a><a href="#catalog">Каталог</a><a href="#contacts">Контакты</a>
        </nav>
        <a className="header-cta" href="#contacts">Получить консультацию <span>↗</span></a>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy"><p className="eyebrow">Корея → Беларусь</p><h1>Автомобили<br />из Кореи <span>под ключ</span></h1><p className="hero-text">Подберём, проверим, доставим и растаможим автомобиль вашей мечты — с понятной ценой и поддержкой на каждом этапе.</p><div className="hero-actions"><a className="button button-primary" href="#catalog">Смотреть каталог <span>↗</span></a><a className="button button-ghost" href="#process">Как это работает</a></div></div>
        <div className="hero-orbit" aria-hidden="true"><span>Проверяем</span><span>Считаем</span><span>Доставляем</span><div className="orbit-car">◒</div></div>
      </section>

      <section className="stats" aria-label="Преимущества"><div><strong>5+</strong><span>лет опыта</span></div><div><strong>1000+</strong><span>авто доставлено</span></div><div><strong>98%</strong><span>довольных клиентов</span></div><div><strong>24/7</strong><span>на связи с вами</span></div></section>
      <section className="section intro" id="about"><div><p className="eyebrow">Почему мы</p><h2>Честный путь<br />от Кореи до Беларуси</h2></div><p>Показываем реальную стоимость автомобиля, проверяем историю и состояние до покупки и остаёмся на связи до момента выдачи ключей.</p></section>
      <section className="section process" id="process"><div className="section-heading"><div><p className="eyebrow">Наш процесс</p><h2>От заявки<br />до ключей</h2></div><p>Понятный маршрут сделки без лишних кругов. На каждом шаге вы знаете, что происходит дальше.</p></div><div className="process-grid">{steps.map(([title, text], index) => <article key={title}><span>0{index + 1}</span><h3>{title}</h3><p>{text}</p></article>)}</div></section>
      <section className="section catalog-teaser" id="catalog"><div className="section-heading catalog-heading"><div><p className="eyebrow">Каталог Кореи</p><h2>Автомобили, которые<br />можно проверить</h2></div><p>Живой каталог Encar с фильтрами, историей и расчётом доставки в Беларусь. В демонстрационном слое показаны реальные состояния будущих карточек.</p></div><CatalogPreview /></section>
      <section className="contact-band" id="contacts"><div><p className="eyebrow">Начнём с консультации</p><h2>Расскажите, какой автомобиль ищете</h2></div><a className="button button-light" href="mailto:Chestnyjprigon@gmail.com">Написать нам <span>↗</span></a></section>
      <footer><span>© {new Date().getFullYear()} Честный пригон</span><span>Автомобили из Кореи в Беларусь</span><a href="tel:+375447543987">+375 (44) 754-39-87</a></footer>
    </main>
  );
}
