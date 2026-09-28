type EquipmentGroup = { name: string; items: readonly (readonly [string, string])[] };

export const equipmentCatalog: readonly EquipmentGroup[] = [
  { name: "Экстерьер и интерьер", items: [["010", "Люк"], ["075", "LED-фары"], ["029", "Ксеноновые фары"], ["059", "Электропривод багажника"], ["080", "Доводчики дверей"], ["024", "Электроскладывание зеркал"], ["017", "Легкосплавные диски"], ["062", "Рейлинги на крыше"]] },
  { name: "Комфорт и управление", items: [["082", "Подогрев руля"], ["083", "Электрорегулировка руля"], ["084", "Подрулевые переключатели"], ["031", "Кнопки управления на руле"], ["030", "Зеркало с автозатемнением"], ["074", "Система Hi-Pass"], ["006", "Центральный замок"], ["008", "Усилитель рулевого управления"], ["007", "Электростеклоподъёмники"]] },
  { name: "Безопасность", items: [["002", "Подушки безопасности"], ["026", "Подушка водителя"], ["027", "Подушка пассажира"], ["020", "Боковые подушки"], ["056", "Шторки безопасности"], ["001", "Антиблокировочная система ABS"], ["019", "Противобуксовочная система TCS"]] },
];

const equipmentNamesByCode = new Map(
  equipmentCatalog.flatMap((group) => group.items).map(([code, name]) => [code, name]),
);

export function equipmentOptionsFromCodes(codes: string[]) {
  return [...new Set(codes)].flatMap((code) => {
    const name = equipmentNamesByCode.get(code);
    return name ? [{ name, priceKrw: null, description: "Стандартная комплектация Encar" }] : [];
  });
}
