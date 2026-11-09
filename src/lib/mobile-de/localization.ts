/** Approved exact-label translations based on the Mobile.de German-to-Russian dictionary. */
const FEATURE_DE_RU: Record<string, string> = {
  'ABS':'Антиблокировочная система (ABS)', 'Reifendruckkontrolle':'Контроль давления в шинах',
  'ESP':'Система курсовой устойчивости (ESP)', 'Zentralverriegelung':'Центральный замок',
  'Servolenkung':'Усилитель рулевого управления', 'Multifunktionslenkrad':'Многофункциональное рулевое колесо',
  'Elektr. Seitenspiegel':'Электрорегулировка боковых зеркал', 'Elektr. Fensterheber':'Электростеклоподъёмники',
  'Bluetooth':'Bluetooth', 'USB':'USB', 'Freisprecheinrichtung':'Система громкой связи',
  'Lichtsensor':'Датчик освещения', 'Elektr. Wegfahrsperre':'Электронный иммобилайзер',
  'Radio DAB':'Цифровое радио DAB', 'Isofix':'Крепления детских кресел ISOFIX',
  'Sitzheizung':'Подогрев сидений', 'Tuner/Radio':'Радио', 'Spurhalteassistent':'Система удержания в полосе',
  'Traktionskontrolle':'Противобуксовочная система', 'Bordcomputer':'Бортовой компьютер',
  'Lederlenkrad':'Кожаное рулевое колесо', 'Müdigkeitswarner':'Система контроля усталости водителя',
  'Notbremsassistent':'Система автоматического экстренного торможения',
  'Verkehrszeichenerkennung':'Распознавание дорожных знаков', 'Apple CarPlay':'Apple CarPlay',
  'Notrufsystem':'Система экстренного вызова', 'Android Auto':'Android Auto',
  'Start/Stopp-Automatik':'Система старт-стоп', 'Leichtmetallfelgen':'Легкосплавные колёсные диски',
  'Touchscreen':'Сенсорный экран', 'LED-Scheinwerfer':'Светодиодные фары',
  'Berganfahrassistent':'Система помощи при трогании на подъёме', 'Garantie':'Гарантия (по заявлению продавца)',
  'LED-Tagfahrlicht':'Светодиодные дневные ходовые огни', 'Geschwindigkeitsbegrenzer':'Ограничитель скорости',
  'Frontantrieb':'Передний привод', 'Regensensor':'Датчик дождя', 'Abstandswarner':'Предупреждение о дистанции',
  'Armlehne':'Подлокотник', 'Fernlichtassistent':'Ассистент управления дальним светом',
  'Navigationssystem':'Навигационная система', 'Volldigitales Kombiinstrument':'Цифровая приборная панель',
  'Nichtraucher-Fahrzeug':'Автомобиль не для курящих (по заявлению продавца)',
  'Innenspiegel autom. abblendend':'Салонное зеркало с автоматическим затемнением',
  'Sprachsteuerung':'Голосовое управление', 'Scheckheftgepflegt':'Сервисная книжка (по заявлению продавца)',
  'Induktionsladen für Smartphones':'Беспроводная зарядка смартфона', 'Lordosenstütze':'Поясничная поддержка',
  'Schlüssellose Zentralverriegelung (Keyless)':'Бесключевой доступ',
  'Abstandstempomat':'Адаптивный круиз-контроль', 'Abgedunkelte Scheiben':'Тонированные стёкла',
  'Pannenkit':'Комплект для ремонта шин', 'Elektr. Seitenspiegel anklappbar':'Электрически складывающиеся боковые зеркала',
  'Beheizbares Lenkrad':'Подогрев рулевого колеса', 'Ambiente-Beleuchtung':'Интерьерная подсветка',
  'Partikelfilter':'Сажевый фильтр', 'Schaltwippen':'Подрулевые лепестки переключения передач',
  'Musikstreaming integriert':'Встроенная передача музыки по Bluetooth', 'Totwinkel-Assistent':'Система контроля слепых зон',
  'Dachreling':'Рейлинги на крыше', 'Sommerreifen':'Летние шины', 'Elektr. Heckklappe':'Электропривод двери багажника',
  'Alarmanlage':'Охранная сигнализация', 'Nebelscheinwerfer':'Противотуманные фары', 'Soundsystem':'Аудиосистема',
  'Tempomat':'Круиз-контроль', 'Blendfreies Fernlicht':'Ассистент дальнего света без ослепления',
  'Sportsitze':'Спортивные сиденья', 'Isofix Beifahrersitz':'Крепления ISOFIX на переднем пассажирском сиденье',
  'Gepäckraumabtrennung':'Перегородка багажного отделения', 'Sportpaket':'Спортивный пакет',
  'Winterpaket':'Зимний пакет', 'Anhängerkupplung schwenkbar':'Поворотное тягово-сцепное устройство',
  'WLAN / Wifi Hotspot':'Точка доступа Wi-Fi', 'Elektr. Sitzeinstellung':'Электрорегулировка сидений',
  'Adaptives Kurvenlicht':'Адаптивное освещение поворотов', 'Ausparkassistent':'Ассистент выезда с парковки',
  'Sportfahrwerk':'Спортивная подвеска', 'Kurvenlicht':'Освещение поворотов', 'Panorama-Dach':'Панорамная крыша',
  'Tagfahrlicht':'Дневные ходовые огни', 'Navigationsvorbereitung':'Подготовка к установке навигационной системы',
  'Head-Up Display':'Проекционный дисплей', 'Beheizbare Frontscheibe':'Обогрев лобового стекла',
  'Sitzheizung hinten':'Подогрев задних сидений', 'Schiebedach':'Люк в крыше', 'Allwetterreifen':'Всесезонные шины',
  'Adaptives Fahrwerk':'Адаптивная подвеска', 'Elektr. Sitzeinstellung mit Memory-Funktion':'Электрорегулировка сидений с памятью настроек',
  'Scheinwerferreinigung':'Омыватели фар', 'Inspektion neu':'Техническое обслуживание выполнено недавно (по заявлению продавца)',
  'Türen: 4/5':'Количество дверей: 4/5', 'Sitze: 5':'Количество мест: 5', 'Stahlfelgen':'Стальные колёсные диски',
  'Standheizung':'Автономный отопитель', 'Anhängerkupplung abnehmbar':'Съёмное тягово-сцепное устройство',
  'CD-Spieler':'CD-проигрыватель', 'Anhängerrangierassistent':'Ассистент маневрирования с прицепом',
  'Sitzbelüftung':'Вентиляция сидений', 'Massagesitze':'Сиденья с функцией массажа',
  'Einparkhilfe':'Парковочный ассистент', 'Einparkhilfe hinten':'Задние датчики парковки',
  'Einparkhilfe vorne':'Передние датчики парковки', 'Einparkhilfe Kamera':'Камера парковки',
  'Rückfahrkamera':'Камера заднего вида', '360°-Kamera':'Камера кругового обзора 360°',
  'Elektr. Sitzeinstellung mit Memory':'Электрорегулировка сидений с памятью настроек',
  'Elektr. Außenspiegel':'Электрорегулировка наружных зеркал', 'Abstandsregeltempomat':'Адаптивный круиз-контроль',
  'Schlüssellose Zentralverriegelung':'Бесключевой доступ', 'Metallic':'Металлик (окраска)',
  'Anhängerkupplung-Vorbereitung':'Подготовка к установке тягово-сцепного устройства',
  'Umklappbarer Beifahrersitz':'Складывающееся переднее пассажирское сиденье',
  'Anhängerkupplung fest':'Фиксированное тягово-сцепное устройство', 'Reserverad':'Запасное колесо',
  'Notrad':'Малоразмерное запасное колесо', 'Winterreifen':'Зимние шины', 'Heckantrieb':'Задний привод',
  'Skisack':'Люк для перевозки длинномерных предметов (лыжный чехол)', 'Raucherpaket':'Пакет для курящих (по заявлению продавца)',
  'Nachtsicht-Assistent':'Система ночного видения', 'Sitze: 4':'Количество мест: 4',
  'Kategorie: Andere':'Категория автомобиля: другая',
  'Kategorie: SUV/Geländewagen/Pickup':'Категория автомобиля: SUV/внедорожник/пикап',
  'Kategorie: Limousine':'Категория автомобиля: седан', 'Kategorie: Kleinwagen':'Категория автомобиля: малолитражный автомобиль',
  'Kategorie: Kombi':'Категория автомобиля: универсал', 'Kategorie: Van/Minibus':'Категория автомобиля: минивэн/микроавтобус',
  'Farbe: Grau':'Цвет по объявлению: серый', 'Farbe: Schwarz':'Цвет по объявлению: чёрный',
  'Farbe: Weiß':'Цвет по объявлению: белый', 'Farbe: Silber':'Цвет по объявлению: серебристый',
  'Farbe: Blau':'Цвет по объявлению: синий', 'Deutsche Ausführung':'Немецкая версия (по заявлению продавца)',
  'HU: Neu':'Техосмотр: новый срок (по заявлению продавца)',
  'Elektr. Sitzeinstellung, hinten':'Электрорегулировка задних сидений', 'Faltdach':'Складная крыша',
  'Electric windows':'Электростеклоподъёмники', 'Alloy wheels':'Легкосплавные колёсные диски',
  'Multifunction steering wheel':'Многофункциональное рулевое колесо', 'Electric side mirror':'Электрорегулировка боковых зеркал',
  'Central locking':'Центральный замок', 'Tyre pressure monitoring':'Контроль давления в шинах',
  'Power Assisted Steering':'Усилитель рулевого управления', 'Traction control':'Противобуксовочная система',
  'Behindertengerecht':'Адаптация для людей с инвалидностью (по заявлению продавца)',
  'TV':'Телевизионный тюнер',
};

const EXTRA_FEATURES: Record<string, string> = {
  "2-Zonen-Klimaautomatik": "Двухзонный климат-контроль", "Bi-Xenon Scheinwerfer": "Биксеноновые фары",
  "Bidirektionales Laden": "Двусторонняя зарядка", "Fahrassistenz-Paket L": "Пакет систем помощи водителю L",
  "Kamera+Parkassistent": "Камера и парковочный ассистент", "Ladebordwand": "Гидроборт",
  "Trennwand": "Перегородка в салоне", "Batteriezertifikat": "Сертификат состояния тяговой батареи",
  "Laserlicht": "Лазерные фары", "LED Scheinwerfer": "Светодиодные фары",
  "Luftfederung": "Пневматическая подвеска", "Multi-CD-Wechsler": "Многодисковый CD-чейнджер",
  "Range Extender": "Увеличитель запаса хода", "Rechtslenker": "Правый руль",
  "Tüv Neu": "Новый техосмотр (по объявлению)", "Virtuelle Seitenspiegel": "Камеры вместо боковых зеркал",
  "Wärmepumpe": "Тепловой насос", "Wireless Full Link": "Беспроводное подключение Full Link",
  "Xenonscheinwerfer": "Ксеноновые фары", "Kommunalfahrzeug": "Коммунальный автомобиль",
  "Taxi": "Такси", "Tier-/Pferdetransport": "Перевозка животных", "Verkaufsaufbau": "Мобильный торговый кузов",
  "Sofort verfügbar": "Доступен сразу (по объявлению)",
  "Finanzierung/Inzahlung": "Возможны финансирование или обмен (по объявлению)",
  "Vermietung möglich": "Возможна аренда (по объявлению)",
};

const EXACT_FIELD: Record<string, string> = {
  "frontantrieb": "Передний привод", "fwd": "Передний привод", "vorderradantrieb": "Передний привод",
  "heckantrieb": "Задний привод", "rwd": "Задний привод", "hinterradantrieb": "Задний привод",
  "allrad": "Полный привод", "allradantrieb": "Полный привод", "awd": "Полный привод", "4x4": "Полный привод",
  "limousine": "Седан", "kombi": "Универсал", "kleinwagen": "Малолитражный автомобиль",
  "sportwagen/coupé": "Спорткар / купе", "suv/geländewagen/pickup": "SUV / внедорожник / пикап",
  "van/minibus": "Минивэн / микроавтобус", "andere": "Другой тип кузова",
  "kastenwagen": "Фургон", "kastenwagen hoch": "Высокий фургон", "kastenwagen lang": "Длинный фургон",
  "kastenwagen hoch + lang": "Высокий длинный фургон", "koffer": "Фургон с закрытым кузовом",
  "pritsche": "Бортовой кузов", "rettungswagen": "Автомобиль скорой помощи",
  "tier-/pferdetransport": "Автомобиль для перевозки животных", "verkaufsaufbau": "Мобильный торговый кузов",
  "kombi, kleinbus bis 9 sitze": "Универсал / микроавтобус до 9 мест",
  "blau": "Синий", "blau metallic": "Синий металлик", "gelb": "Жёлтый", "gelb metallic": "Жёлтый металлик",
  "grau": "Серый", "grau metallic": "Серый металлик", "gris platinium": "Платиновый серый",
  "grün": "Зелёный", "grün metallic": "Зелёный металлик", "rot": "Красный", "rot metallic": "Красный металлик",
  "kwe - lack weiss perlglänzend": "Белый перламутровый лак", "lackierung olivgrün/typ aussenve": "Оливково-зелёный кузов",
  "lackierung platinium-grau/meta": "Платиново-серый металлик", "olivine": "Оливковый",
  "perla nera": "Чёрный перламутровый лак",
  "schwarz": "Чёрный", "schwarz metallic": "Чёрный металлик", "silber": "Серебристый",
  "silber metallic": "Серебристый металлик", "weiß": "Белый", "weiß matt": "Белый матовый", "weiß metallic": "Белый металлик",
  "electric": "Электрический двигатель", "petrol": "Бензин", "diesel": "Дизель", "other": "Другое",
  "automatisch": "Автоматическая коробка передач", "automatic": "Автоматическая коробка передач",
  "automatik": "Автоматическая коробка передач", "automatic transmission": "Автоматическая коробка передач",
  "manuell": "Механическая коробка передач", "manual": "Механическая коробка передач",
  "schaltgetriebe": "Механическая коробка передач", "manual transmission": "Механическая коробка передач",
};

const NON_EQUIPMENT = /^(?:Kategorie\s*:|Farbe\s*:|(?:стоимость в ЕС без расчетов|итоговый расчет в ходе консультации с менеджером)\.?$)/i;
const normKey = (value: string) => value.trim().toLocaleLowerCase("de-DE").replace(/\s+/g, " ");

export function normalizeMobileDeField(value: unknown, field: "fuel" | "transmission" | "drive" | "body" | "color"): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  const key = normKey(raw);
  if (field === "body") {
    const demo = /,\s*(?:Vorführfahrzeug|Tageszulassung)$/i.test(raw);
    const clean = raw.replace(/,\s*(?:Vorführfahrzeug|Tageszulassung)$/i, "");
    const mapped = EXACT_FIELD[normKey(clean)];
    return mapped ? `${mapped}${demo ? " (демо-автомобиль)" : ""}` : raw;
  }
  return EXACT_FIELD[key] ?? raw;
}

export function normalizeMobileDeOption(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || NON_EQUIPMENT.test(raw)) return null;
  // Keep values already localized by this projection so backfills are idempotent.
  if (/[а-яё]/i.test(raw)) return raw;
  const exact = FEATURE_DE_RU[raw] ?? EXTRA_FEATURES[raw];
  if (exact) return exact;
  const owners = raw.match(/^Fahrzeughalter:\s*(\d{1,2})$/i);
  if (owners) return `Количество владельцев по объявлению: ${owners[1]}`;
  const seats = raw.match(/^Sitze:\s*(\d{1,2})$/i);
  if (seats) return `Количество мест: ${seats[1]}`;
  const doors = raw.match(/^Türen:\s*(\d(?:\/\d)?)$/i);
  if (doors) return `Количество дверей: ${doors[1]}`;
  if (/^1-HAND\s*-\s*Kamera$/i.test(raw)) return "Камера; один владелец (по объявлению)";
  if (/^AHK,LED,Bose,ACC,Kamer/i.test(raw)) return "Фаркоп; светодиодные фары; аудиосистема Bose; адаптивный круиз-контроль; камера";
  if (/^(?:Kategorie\s*:|Finanzierung\/Inzahlung|Sofort verfügbar|Vermietung möglich)/i.test(raw)) return null;
  return null;
}

export function normalizeMobileDeOptions(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.flatMap((value) => {
    const text = typeof value === "string" ? value : value && typeof value === "object"
      ? ["name", "value"].map((key) => (value as Record<string, unknown>)[key]).find((item) => typeof item === "string")
      : null;
    const normalized = normalizeMobileDeOption(text);
    return normalized ? [normalized] : [];
  }))];
}
