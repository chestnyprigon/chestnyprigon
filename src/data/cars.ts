export type CarFuel = "Бензин" | "Дизель" | "Гибрид" | "Электро";

export type CatalogCar = {
  id: string;
  brand: "Genesis" | "Hyundai" | "Kia";
  model: string;
  trim: string;
  year: number;
  mileage: number;
  engine: string;
  fuel: CarFuel;
  drive: "AWD" | "FWD" | "RWD";
  price: number;
  location: string;
  image: string;
  status: "Проверено" | "Новый лот" | "В наличии";
};

export const catalogCars: CatalogCar[] = [
  { id: "genesis-gv70-01", brand: "Genesis", model: "GV70", trim: "2.5T AWD", year: 2023, mileage: 28400, engine: "2.5 л", fuel: "Бензин", drive: "AWD", price: 32900, location: "Сеул", image: "/assets/catalog/genesis.svg", status: "Проверено" },
  { id: "kia-sorento-01", brand: "Kia", model: "Sorento", trim: "Signature", year: 2022, mileage: 41200, engine: "2.2 л", fuel: "Дизель", drive: "AWD", price: 24700, location: "Инчхон", image: "/assets/catalog/kia.svg", status: "Новый лот" },
  { id: "hyundai-palisade-01", brand: "Hyundai", model: "Palisade", trim: "Calligraphy", year: 2024, mileage: 16850, engine: "2.5 л", fuel: "Бензин", drive: "AWD", price: 41300, location: "Сувон", image: "/assets/catalog/hyundai.svg", status: "В наличии" },
  { id: "genesis-g80-01", brand: "Genesis", model: "G80", trim: "2.5T Luxury", year: 2022, mileage: 35700, engine: "2.5 л", fuel: "Бензин", drive: "AWD", price: 28600, location: "Пусан", image: "/assets/catalog/genesis.svg", status: "Проверено" },
  { id: "kia-carnival-01", brand: "Kia", model: "Carnival", trim: "Noblesse 9 seats", year: 2023, mileage: 52200, engine: "2.2 л", fuel: "Дизель", drive: "FWD", price: 26900, location: "Тэджон", image: "/assets/catalog/kia.svg", status: "Новый лот" },
  { id: "hyundai-santafe-01", brand: "Hyundai", model: "Santa Fe", trim: "Hybrid Calligraphy", year: 2024, mileage: 12100, engine: "1.6 л", fuel: "Гибрид", drive: "AWD", price: 35400, location: "Сеул", image: "/assets/catalog/hyundai.svg", status: "Проверено" },
  { id: "genesis-gv80-01", brand: "Genesis", model: "GV80", trim: "3.5T AWD", year: 2021, mileage: 63800, engine: "3.5 л", fuel: "Бензин", drive: "AWD", price: 34700, location: "Инчхон", image: "/assets/catalog/genesis.svg", status: "В наличии" },
  { id: "kia-ev6-01", brand: "Kia", model: "EV6", trim: "GT-Line AWD", year: 2023, mileage: 19900, engine: "77.4 кВт⋅ч", fuel: "Электро", drive: "AWD", price: 31800, location: "Соннам", image: "/assets/catalog/kia.svg", status: "Проверено" },
  { id: "hyundai-tucson-01", brand: "Hyundai", model: "Tucson", trim: "Inspiration", year: 2022, mileage: 44600, engine: "1.6 л", fuel: "Гибрид", drive: "AWD", price: 22800, location: "Пусан", image: "/assets/catalog/hyundai.svg", status: "Новый лот" },
];
