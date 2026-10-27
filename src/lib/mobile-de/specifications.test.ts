import assert from "node:assert/strict";
import test from "node:test";
import { mobileDeSpecifications } from "./specifications";
import type { MobileDeListing } from "./types";
const fixture = {
  production_year: null, first_registration: {value:"2025-08"}, mileage_km:8831, engine_cc:1332,
  power:{value:136, label_ru:"л. с."}, drive:"Передний привод", transmission:"Автоматическая коробка передач",
  fuel_type:null, body_type:null, color:null,
  description:"По заявлению продавца:\nSUV / внедорожник / пикап\nПервая регистрация: 08/2025\nПробег: 8.831 км\nОбъём двигателя: 1.332 см³\nБензин\nАвтоматическая коробка передач\nСерый\nКоличество дверей: 4/5\nКоличество мест: 5\nТехосмотр: новый срок (по заявлению продавца)\nКоличество владельцев: 1"
} as MobileDeListing;
test("seller text fills missing specs without repeating structured fields",()=>{
 const specs=mobileDeSpecifications(fixture);const values=new Map(specs);
 assert.equal(values.get("Топливо"),"Бензин");assert.equal(values.get("Цвет"),"Серый");
 assert.equal(values.get("Кузов"),"SUV / внедорожник / пикап");assert.equal(values.get("Количество мест"),"5");
 assert.equal(values.get("Первая регистрация"),"08.2025");assert.equal(values.get("Пробег"),"8 831 км");
 assert.equal(values.get("Количество владельцев"),"1");
 assert.equal(values.get("Техосмотр"),"новый срок (по заявлению продавца)");
 assert.equal(specs.length,new Set(specs.map(([key])=>key)).size);
 assert.equal(values.get("Год выпуска"),"Не указано");
});
test("API wins over conflicting seller text and missing numbers are parsed conservatively",()=>{
 const specs=new Map(mobileDeSpecifications({...fixture,color:"Белый",fuel_type:"Дизель",mileage_km:9000,engine_cc:null}));
 assert.equal(specs.get("Цвет"),"Белый");assert.equal(specs.get("Топливо"),"Дизель");
 assert.equal(specs.get("Пробег"),"9 000 км");assert.equal(specs.get("Объём двигателя"),"1 332 см³");
});
test("missing descriptions do not invent extra specifications",()=>{
 const values=new Map(mobileDeSpecifications({...fixture,description:null}));
 assert.equal(values.has("Количество владельцев"),false);assert.equal(values.get("Топливо"),"Не указано");
});
test("litres are converted to cubic centimetres and ambiguous mileages are not guessed",()=>{
 const values=new Map(mobileDeSpecifications({...fixture,engine_cc:null,mileage_km:null,description:"Объем двигателя: 1,3 л\nПробег: 8.8 тыс. км"}));
 assert.equal(values.get("Объём двигателя"),"1 300 см³");
 assert.equal(values.get("Пробег"),"8.8 тыс. км");
});
