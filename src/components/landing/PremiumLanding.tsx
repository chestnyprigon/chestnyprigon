"use client";

import {
  ArrowRight,
  BadgeCheck,
  Calculator,
  CarFront,
  Check,
  Camera,
  FileCheck2,
  Headphones,
  Mail,
  MapPin,
  Menu,
  MessageCircle,
  Phone,
  Search,
  Send,
  ShieldCheck,
  Ship,
  Sparkles,
  X,
  Video,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

const processSteps = [
  { title: "Консультация", short: "Уточняем запрос и подбираем направление", icon: MessageCircle, text: "Фиксируем марку, модель, бюджет, сроки и ключевые пожелания. Показываем понятный маршрут сделки до старта работы.", points: ["Первичная подборка вариантов", "Понятные сроки и следующие шаги", "Связь удобным для вас способом"] },
  { title: "Договор", short: "Закрепляем условия сотрудничества", icon: FileCheck2, text: "Подписываем договор онлайн или в офисе и фиксируем порядок сопровождения сделки.", points: ["Прозрачные условия", "Зафиксированная комиссия", "Официальные документы"] },
  { title: "Подбор", short: "Отбираем автомобили под ваши критерии", icon: Search, text: "Сравниваем предложения Encar по состоянию, комплектации, пробегу и цене.", points: ["Только актуальные объявления", "Релевантные варианты под ваш запрос", "Сравнение сильных предложений"] },
  { title: "Расчёт", short: "Формируем стоимость под ключ в USD", icon: Calculator, text: "Показываем автомобиль, логистику, таможенные платежи и услуги отдельными понятными строками.", points: ["Без скрытых платежей", "Расчёт до решения о покупке", "Фиксация курса и даты"] },
  { title: "Проверка", short: "Изучаем историю и техническое состояние", icon: ShieldCheck, text: "Проверяем страховую историю, пробег, комплектацию и доступные отчёты по автомобилю.", points: ["История и ограничения", "Фото и документы", "Рекомендация специалиста"] },
  { title: "Оплата", short: "Сопровождаем оплату по инвойсу", icon: BadgeCheck, text: "Объясняем последовательность платежей и остаёмся на связи до подтверждения сделки.", points: ["Проверенный порядок оплаты", "Контроль получения средств", "Документы по сделке"] },
  { title: "Доставка", short: "Контролируем маршрут автомобиля", icon: Ship, text: "Отслеживаем автомобиль от площадки в Корее до прибытия в Беларусь и сообщаем статусы.", points: ["Фотофиксация этапов", "Статусы движения", "Контроль логистики"] },
  { title: "Растаможка", short: "Помогаем с документами и выдачей", icon: CarFront, text: "Готовим пакет документов, объясняем порядок оформления и сопровождаем до передачи автомобиля.", points: ["Таможенное оформление", "Комплект документов", "Передача ключей"] },
];

const cars = [
  { name: "Genesis GV70 2.5T AWD", year: "2023", mileage: "28 400 км", specs: "2.5 л · бензин · AWD", price: "$32 900", status: "ПРОВЕРЕНО", image: "/assets/hero/hero-korea-v1.png" },
  { name: "Kia Sorento Signature", year: "2022", mileage: "41 200 км", specs: "2.2 л · дизель · AWD", price: "$24 700", status: "СВЕЖИЙ ЛОТ", image: "/assets/hero/hero-korea-v1.png" },
  { name: "Hyundai Palisade Calligraphy", year: "2024", mileage: "16 850 км", specs: "2.5 л · бензин · AWD", price: "$41 300", status: "В НАЛИЧИИ", image: "/assets/hero/hero-korea-v1.png" },
];

const reviews = [
  ["АМ", "Алексей М.", "Брест", "Автомобиль пришёл ровно в том состоянии, которое показали до покупки. Бюджет не изменился, по каждому этапу были понятные обновления."],
  ["ИК", "Игорь К.", "Гомель", "Отдельно понравилось, что историю и комплектацию объяснили простым языком. Не торопили и помогли спокойно сравнить варианты."],
  ["МЕ", "Мария Е.", "Гродно", "Для меня было важно понимать итоговую цену заранее. Получила полный расчёт и ни одного неожиданного платежа после покупки."],
  ["ДС", "Дмитрий С.", "Витебск", "Быстро нашли сильный вариант под бюджет и контролировали всю логистику. Машину забрал без лишней суеты."],
  ["ОВ", "Ольга В.", "Могилёв", "Не пропали после оплаты: присылали статусы, фото и помогли с документами уже в Беларуси."],
  ["НР", "Никита Р.", "Минск", "Самое ценное — предсказуемость. Я заранее понимал цену, сроки и следующий шаг сделки."],
];

const faqs = [
  ["Сколько времени занимает доставка автомобиля?", "Ориентировочно 6–10 недель. Точный срок зависит от площадки, порта отправления, графика судов и маршрута до Беларуси."],
  ["Как формируется цена под ключ?", "Отдельно показываем цену автомобиля, расходы в Корее, логистику, таможенные платежи и нашу комиссию. Итог отображается в долларах США."],
  ["Можно ли проверить автомобиль до покупки?", "Да. Проверяем историю, пробег, комплектацию, фотографии и доступные отчёты. По спорным вариантам рекомендуем отказаться от покупки."],
  ["Какие документы я получу?", "Договор, инвойс, экспортные и таможенные документы, а также подтверждения по логистике и оплате."],
  ["Есть ли скрытые платежи?", "Нет. Все обязательные и сервисные расходы показываются до покупки. Если ставка зависит от курса или тарифа, это указывается отдельно."],
  ["Можно заказать редкую комплектацию?", "Да. Мы можем настроить индивидуальный поиск и сообщать о новых подходящих предложениях."],
  ["Вы помогаете с постановкой на учёт?", "Подскажем порядок действий и необходимый комплект документов после выдачи автомобиля."],
];

export function PremiumLanding() {
  const [processOpen, setProcessOpen] = useState(0);
  const [faqOpen, setFaqOpen] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    document.body.style.overflow = modalOpen || menuOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [modalOpen, menuOpen]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
  };

  return <main>
    <header className="premium-header">
      <a className="premium-brand" href="#home" aria-label="Честный пригон"><span className="premium-brand-mark"><i /><i /></span><span><b>ЧЕСТНЫЙ <em>ПРИГОН</em></b><small>Автомобили из Кореи</small></span></a>
      <nav className={menuOpen ? "premium-nav is-open" : "premium-nav"}><a href="#home" onClick={() => setMenuOpen(false)}>Главная</a><Link href="/catalog" onClick={() => setMenuOpen(false)}>Каталог</Link><a href="#services" onClick={() => setMenuOpen(false)}>Услуги</a><a href="#reviews" onClick={() => setMenuOpen(false)}>Отзывы</a><a href="#contacts" onClick={() => setMenuOpen(false)}>Контакты</a></nav>
      <button className="premium-header-cta" type="button" onClick={() => setModalOpen(true)}>Получить консультацию <ArrowRight size={16} /></button>
      <button className="premium-menu-button" type="button" onClick={() => setMenuOpen(!menuOpen)} aria-label="Меню">{menuOpen ? <X /> : <Menu />}</button>
    </header>

    <section className="premium-hero" id="home">
      <div className="premium-hero-bg" />
      <div className="premium-hero-content"><p className="premium-kicker"><span />Автомобили из Южной Кореи</p><h1>Автомобили<br />из Кореи<br /><em>под ключ</em></h1><p className="premium-lead">Подберём, проверим, доставим и растаможим автомобиль вашей мечты без лишних хлопот.</p><div className="premium-actions"><button className="premium-button primary" type="button" onClick={() => setModalOpen(true)}>Подобрать автомобиль <ArrowRight size={17} /></button><Link className="premium-button secondary" href="/catalog">Смотреть каталог</Link></div></div>
      <div className="premium-trust"><div><ShieldCheck /><b>5+ лет</b><span>опыта</span></div><div><CarFront /><b>1000+</b><span>авто доставлено</span></div><div><Sparkles /><b>98%</b><span>довольных клиентов</span></div><div className="premium-route"><span className="korea-flag">☯</span><b>Корея → Беларусь</b><span>подбор · проверка · доставка</span></div></div>
    </section>

    <section className="premium-process premium-section" id="services"><div className="premium-section-copy"><p className="premium-kicker"><span />Как мы работаем</p><h2>Маршрут сделки<br />от заявки до ключей</h2><p>Вы сразу видите последовательность работы, документы и действия на каждом этапе.</p></div><div className="process-list">{processSteps.map((step, index) => { const Icon = step.icon; const open = processOpen === index; return <article className={open ? "process-item is-open" : "process-item"} key={step.title}><button type="button" onClick={() => setProcessOpen(open ? -1 : index)}><span className="process-number">{String(index + 1).padStart(2, "0")}</span><Icon size={18} /><b>{step.title}</b><em>{step.short}</em><span className="process-toggle">{open ? "×" : "+"}</span></button>{open && <div className="process-details"><p>{step.text}</p><ul>{step.points.map((point) => <li key={point}><Check size={14} />{point}</li>)}</ul></div>}</article>; })}</div></section>

    <section className="premium-catalog premium-section" id="catalog"><div className="premium-section-head"><div><p className="premium-kicker"><span />Каталог Кореи</p><h2>Свежие предложения<br />с понятной историей</h2></div><div className="catalog-meta"><span className="korea-pill">🇰🇷 Только Корея</span><p>Демонстрационные карточки до подключения Encar</p></div></div><div className="premium-car-grid">{cars.map((car, index) => <article className="premium-car-card" key={car.name}><div className="premium-car-image"><Image src={car.image} alt="" fill sizes="(max-width: 720px) 100vw, 33vw" style={{ objectFit: "cover", objectPosition: `${62 + index * 7}% center` }} /><span>{car.status}</span><small>КОРЕЯ 🇰🇷</small></div><div className="premium-car-body"><h3>{car.name}</h3><p>{car.year} · {car.mileage}<br />{car.specs}</p><div><strong>{car.price}</strong><button type="button" onClick={() => setModalOpen(true)}>Подробнее <ArrowRight size={15} /></button></div></div></article>)}</div><div className="premium-catalog-footer"><button className="premium-button primary" type="button" onClick={() => setModalOpen(true)}>Подобрать авто <ArrowRight size={17} /></button></div></section>

    <section className="premium-reviews" id="reviews"><div className="premium-section-copy centered"><p className="premium-kicker"><span />Отзывы</p><h2>Люди, которые уже<br />забрали свои автомобили</h2><p>Здесь будут подтверждённые отзывы клиентов. Пока блок показывает согласуемый дизайн и формат.</p></div><div className="reviews-track">{[...reviews, ...reviews].map(([initials, name, city, text], index) => <article key={`${name}-${index}`}><div><span>{initials}</span><p><b>{name}</b><small>{city}</small></p></div><p>{text}</p></article>)}</div></section>

    <section className="premium-faq premium-section"><div className="premium-section-copy centered"><p className="premium-kicker"><span />FAQ</p><h2>Часто задаваемые вопросы</h2><p>Коротко объясняем процесс покупки и доставки автомобиля из Кореи.</p></div><div className="faq-grid">{faqs.map(([question, answer], index) => { const open = faqOpen === index; return <article className={open ? "faq-item is-open" : "faq-item"} key={question}><button type="button" onClick={() => setFaqOpen(open ? -1 : index)}><b>{question}</b><span>{open ? "×" : "+"}</span></button>{open && <p>{answer}</p>}</article>; })}</div><div className="faq-support"><Headphones /><span><b>Не нашли ответ?</b><small>Расскажите о задаче — разберём ваш сценарий покупки.</small></span><button className="premium-button primary" type="button" onClick={() => setModalOpen(true)}>Связаться с нами <ArrowRight size={16} /></button></div></section>

    <section className="premium-contacts premium-section" id="contacts"><div className="contacts-card"><div className="contacts-copy"><p className="premium-kicker"><span />Контакты</p><h2>Свяжитесь с нами<br />и запустим подбор</h2><p>Офис компании в Минске. Работаем с автомобилями из Южной Кореи.</p><div className="contacts-map"><iframe title="Офис на карте" src="https://yandex.ru/map-widget/v1/?text=%D0%9C%D0%B8%D0%BD%D1%81%D0%BA%2C%20%D1%83%D0%BB.%20%D0%9C%D0%B5%D0%BB%D0%B5%D0%B6%D0%B0%2C%20%D0%B4.%203&z=16" loading="lazy" /></div></div><div className="contacts-links"><a href="tel:+375447543987"><Phone />+375 (44) 754-39-87</a><a href="mailto:Chestnyjprigon@gmail.com"><Mail />Chestnyjprigon@gmail.com</a><a href="https://maps.google.com/?q=Минск+Мележа+3" target="_blank" rel="noreferrer"><MapPin />г. Минск, ул. Мележа, д. 3, оф. 603</a><button type="button" onClick={() => setModalOpen(true)}><Send />Telegram <ArrowRight /></button><button type="button" onClick={() => setModalOpen(true)}><Camera />Instagram <ArrowRight /></button><button type="button" onClick={() => setModalOpen(true)}><Video />YouTube <ArrowRight /></button><button className="contacts-main" type="button" onClick={() => setModalOpen(true)}><Mail />Написать нам <ArrowRight /></button></div></div>
      <form className="lead-banner" onSubmit={submit}><div><p className="premium-kicker"><span />Бесплатная консультация</p><h2>Подберём ваш<br />идеальный автомобиль</h2><p>Оставьте заявку — подготовим подборку и предварительный расчёт.</p><ul><li><Check />Прозрачная цена</li><li><Check />Проверка истории</li><li><Check />Без скрытых платежей</li></ul></div><div className="lead-fields">{submitted ? <div className="lead-success"><BadgeCheck /><b>Заявка принята</b><span>На следующем этапе подключим реальную отправку менеджеру.</span></div> : <><input name="name" placeholder="Ваше имя" required /><input name="phone" placeholder="Телефон" required /><input name="car" placeholder="Интересующий автомобиль" /><button type="submit">Отправить заявку <ArrowRight /></button><small>Нажимая кнопку, вы соглашаетесь с политикой конфиденциальности</small></>}</div></form>
    </section>

    <footer className="premium-footer"><div className="footer-brand"><b>ЧЕСТНЫЙ<br /><em>ПРИГОН</em></b><p>Автомобили из Кореи<br />с доставкой в Беларусь</p></div><div><b>Услуги</b><Link href="/catalog">Подбор автомобиля</Link><a href="#services">Проверка и покупка</a><a href="#services">Доставка</a><a href="#services">Таможенное оформление</a></div><div><b>Контакты</b><a href="tel:+375447543987">+375 (44) 754-39-87</a><a href="mailto:Chestnyjprigon@gmail.com">Chestnyjprigon@gmail.com</a><span>Минск, ул. Мележа, 3</span></div><div><b>Мы в соцсетях</b><div className="footer-social"><button type="button" onClick={() => setModalOpen(true)}><Send /></button><button type="button" onClick={() => setModalOpen(true)}><Camera /></button><button type="button" onClick={() => setModalOpen(true)}><Video /></button></div></div></footer>

    {modalOpen && <div className="consult-modal-backdrop" onMouseDown={() => setModalOpen(false)}><div className="consult-modal" role="dialog" aria-modal="true" aria-label="Получить консультацию" onMouseDown={(event) => event.stopPropagation()}><button className="consult-close" type="button" onClick={() => setModalOpen(false)}><X /></button><p className="premium-kicker"><span />Консультация</p><h2>Как удобнее связаться?</h2><p>Выберите мессенджер или оставьте телефон — данные автомобиля будут передаваться в заявку автоматически после подключения каталога.</p><div className="messenger-grid"><a href="https://t.me/" target="_blank" rel="noreferrer"><Send />Telegram <ArrowRight /></a><a href="https://wa.me/375447543987" target="_blank" rel="noreferrer"><MessageCircle />WhatsApp <ArrowRight /></a><a href="tel:+375447543987"><Phone />Позвонить <ArrowRight /></a><a href="mailto:Chestnyjprigon@gmail.com"><Mail />Email <ArrowRight /></a></div></div></div>}
  </main>;
}
