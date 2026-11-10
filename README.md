# Ro-Lí 2D Designer

Önálló 2D terméktervező a termékprofilok külön adminfelületével.

## Indítás és ellenőrzés

```sh
npm install
npm run dev
```

- `npm run dev` csak a Vite felületet futtatja, a Cloudflare Pages API-kat nem.
- A helyi D1/R2 API-emulációhoz előbb készítsd el a buildet, futtasd a `npm run db:migrate:local` és `npm run dev:cloudflare` parancsokat. A Wrangler helyi emulátort használ, ez nem éles adatbázis vagy bucket. A helyi szerver nem ad ki Cloudflare Access JWT-t, ezért az admin API-k Access-hitelesítése helyben csak érvényes Access JWT-vel ellenőrizhető; a `.dev.vars.example` értékei önmagukban nem jelentenek bejelentkezést.
- `/` és `/szerkeszto/`: az első aktív termék 2D szerkesztője
- `/szerkeszto/:termek-slug`: kizárólag a megadott aktív termék szerkesztője; a kiválasztott nézet referenciafotója adja a vászon természetes méretét
- `/termekek/`: termékprofilok kezelése
- `/termekek/igenyek/`: Access-védett vásárlói igénycsomagok és fájlok
- `/termekek/:termek-slug`: termékprofil konfigurálása

Fejlesztői módban a katalógus és a feltöltött képek a böngésző helyi tárhelyén maradnak. A termék nézetei: elöl, hátul, jobb és bal oldal; csak a teljesen konfigurált nézetek jelennek meg a szerkesztőben. Minden nézethez külön képgaléria, referenciafotó, színmaszk, mintamaszk és védőmaszkok tartoznak. A kiválasztott referenciafotó természetes képmérete adja az adott nézet vásznát.

A tervek többnézetes JSON-fájlként exportálhatók; minden nézet szerkesztési állapota külön marad. A régi, v1-es egyképes tervfájlok továbbra is betölthetők. Az „Igénycsomag beküldése” a tényleges szerkesztőnézetekből PNG-ket készít, ezekből PDF-összesítőt és ZIP-csomagot állít elő, majd tartósan beküldi a tervet és az eredeti feltöltött grafikákat. A mentés rendelés-/tételstruktúrát használ, de a Shopify-azonosítók üresek maradnak; valódi Shopify-rendelések lekérése vagy checkout-integráció nincs.

Az igénycsomagok a D1 `designer_orders`, `designer_order_items` és `designer_order_files` tábláiba, a fájlok privát `customer-artwork` célú R2-objektumokba kerülnek. A vásárlói beküldés az aktív termékhez és tervhez szerveroldalon ellenőrzött, IP-hash alapján óránként legfeljebb 20 kérésre korlátozott. A fájlok az `/api/assets/:assetId` végponton nem nyilvánosak; az adminlista és a fájlletöltés Cloudflare Access-hitelesítést igényel. A helyi Vite preview nem biztosít D1/R2 API-t, ezért a beküldés tartós teszteléséhez konfigurált Cloudflare Pages/Workers környezet szükséges.

A mintamaszk vágja a mintákat, feliratokat és saját grafikákat, a védőmaszkok pedig csak az adott nézet eredeti termékfotóját jelenítik meg ezek fölött. A nézet referenciafotójának, színmaszkjának, mintamaszkjának és védőmaszkjainak képpontmérete egyezzen; az admin aktiváláskor ellenőrzi a méreteket és a maszkok átlátszóságát. A képek termékből való eltávolítása nem törli a fájlt. Végleges törlés csak mentett katalógusból leválasztott fájlra kérhető; a helyi tár és az éles D1/R2 útvonal is visszautasítja, ha maradt katalógushivatkozás.

Az admin termékenként opcionális `shopifyProductId`, anyagonként opcionális `shopifyVariantId` mezőket tárol. Ezeket csak valós Shopify-azonosítókkal szabad kitölteni. A Shopify-adatlekérés és kosárba helyezés ebben a szakaszban nincs megvalósítva: helyben a korábbi tesztárak jelennek meg, éles felületen hiányzó Shopify-ár esetén az „Nem érhető el” állapot látszik, nem helyettesítő ár.

```sh
npm run build
npm run test:designer
```

## Tartós tárhely

Éles Pages-konfiguráció mintája a `wrangler.toml.example`; a D1- és R2-azonosítókat nem ismerjük, ezért innen `wrangler.toml`-ként másolás után a tényleges Cloudflare-adatokkal kell kitölteni. A `SHOP_DB` D1 binding és a `SHOP_ASSETS` R2 binding neve egyezik az API-k által használt nevekkel. Ne használj másik projekt vagy webshop D1-adatbázisát.

A helyi Pages-futtatáshoz a `wrangler.local.toml` külön, Wrangler által emulált `roli-local` D1-adatbázist és `roli-local-assets` R2-bucketet definiál; itt a `npm run db:migrate:local` csak a helyi emulátor sémáját állítja be. A böngészős Vite fejlesztői szerver (`npm run dev`) továbbra is csak a frontend.

Éles telepítés előtt a Cloudflare Pages projekten állíts be `SHOP_DB` D1 bindingot és `SHOP_ASSETS` R2 bindingot a mintafájlban megadott, létező erőforrásokra. A termékkatalógust az `/api/designer-products` és az `/api/admin/designer-products`, a képeket és maszkokat az `/api/admin/assets` és `/api/assets/:assetId` útvonalak kezelik. A vásárlói igénylista a védett `/api/admin/designer-requests` útvonalat használja; a nyilvános beküldés továbbra is az `/api/designer-requests` POST. Az admin fájlelérés és -törlés az `/api/admin/*` útvonalakra került.

Cloudflare Accessben védd legalább a Pages domain `/termekek/*` és `/api/admin/*` útvonalait, és hozz létre adminisztrátori belépési szabályt. Az Access application team domain és audience értékét Pages-environment változóként (`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`) kell beállítani; helyben ezek `.dev.vars` fájlból olvashatók. A `.dev.vars` ne kerüljön verziókezelésbe.

A `migrations/` fájlok meglévő, sorrendben futtatandó migrációk. Éles adatbázison előbb ellenőrizd a migrációk állapotát és készíts mentést, mert itt sem a migrációk alkalmazása, sem éles adat módosítása nem történt. A `0004_customer_design_requests.sql` a tartós igénycsomag-táblákat hozza létre; ne futtasd újra azokat a migrációkat, amelyeket a Cloudflare már alkalmazottnak jelez.

A `0005_optional_material_prices.sql` a meglévő anyagindexben engedi a hiányzó helyi tesztárat, és a jelenlegi Shopify-azonosító mezőket indexeli. A tényleges ár továbbra is csak a későbbi Shopify-integrációból származhat; a hiányzó ár nem nulla. Az új migrációt is csak a korábbiak állapotának ellenőrzése és mentés után szabad éles adatbázison alkalmazni.

## Fő modulok

- `src/designer-prototype/`: vásznas szerkesztő, profilok, anyagok, minták, terv beolvasása és exportja
- `src/designer-admin/`: termékadminisztráció, vásárlói igénylista, PNG/PDF/ZIP-csomagkészítés és helyi katalógus átvitele
- `src/data/designer-assets.ts`: helyi és tartós képtár
- `functions/api/`: szerkesztő-katalógus és képtár API
- `public/images/`: az alapértelmezett termékfotó, maszkok és anyagtextúrák
