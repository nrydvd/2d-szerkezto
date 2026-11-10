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

A tervek többnézetes JSON-fájlként exportálhatók; minden nézet szerkesztési állapota külön marad. A régi, v1-es egyképes tervfájlok továbbra is betölthetők. Az „Igénycsomag beküldése” nézetenként külön termékelőnézetet és átlátszó gyártási PNG-t, valamint PDF-összesítőt és ZIP-csomagot állít elő, majd beküldi a tervet és az eredeti feltöltött grafikákat. A „Gyártási PNG” a kiválasztott nézetet külön is letölti. A gyártási fájl a mintamaszk látható, védőmaszkokon kívüli határoló téglalapjára van vágva, természetes fotó-/maszkfelbontáson; nem tartalmaz termékfotót vagy háttérszínt. Fizikai méret és DPI nincs megadva, ezeket a gyártáshoz külön egyeztetni kell.

Az igénycsomagok a D1 `designer_orders`, `designer_order_items` és `designer_order_files` tábláiba, a fájlok privát `customer-artwork` célú R2-objektumokba kerülnek. A vásárlói beküldés az aktív termékhez és tervhez szerveroldalon ellenőrzött, IP-hash alapján óránként legfeljebb 20 kérésre korlátozott. A fájlok az `/api/assets/:assetId` végponton nem nyilvánosak; az adminlista és a fájlletöltés Cloudflare Access-hitelesítést igényel. A helyi Vite preview nem biztosít D1/R2 API-t, ezért a beküldés tartós teszteléséhez konfigurált Cloudflare Pages/Workers környezet szükséges.

A mintamaszk vágja a mintákat, feliratokat és saját grafikákat, a védőmaszkok pedig csak az adott nézet eredeti termékfotóját jelenítik meg ezek fölött. A nézet referenciafotójának, színmaszkjának, mintamaszkjának és védőmaszkjainak képpontmérete egyezzen; az admin aktiváláskor ellenőrzi a méreteket és a maszkok átlátszóságát. A képek termékből való eltávolítása nem törli a fájlt. Végleges törlés csak mentett katalógusból leválasztott fájlra kérhető; a helyi tár és az éles D1/R2 útvonal is visszautasítja, ha maradt katalógushivatkozás.

Az admin termékenként opcionális `shopifyProductId`, anyagonként opcionális `shopifyVariantId` mezőket tárol. Ezeket csak valós Shopify-azonosítókkal szabad kitölteni. A `noi-neszeszter` helyett a tényleges `noi-neszeszer` slughoz a megadott női neszeszer- és variánsazonosítók központi tartalékkonfigurációja a `functions/_shared/shopify.js` fájlban található; az adminmezők elsőbbséget élveznek. Az ár kizárólag a Storefront API-ból származik; ha nem áll rendelkezésre, „Nem érhető el” látszik. A több nézetből álló tervnél vásárlás előtt minden nézeten ugyanazt az anyagot kell kiválasztani.

## Shopify-kapcsolat beállítása

A kód külső beállítások, migráció és deploy nélkül nem aktiválható; éles működése még ellenőrizendő.

1. A Shopify Adminban hozz létre vagy használj a Storefront API-hoz jogosult alkalmazást/csatornát, a termék- és variánsolvasáshoz szükséges hozzáféréssel (`unauthenticated_read_product_listings`) és kosárkezelési jogosultsággal. A terméket és variánsait tedd elérhetővé a megfelelő értékesítési csatornán. Másold ki a Storefront API hozzáférési tokent és az áruház pontos `*.myshopify.com` domainjét.
2. Cloudflare Dashboard → Workers & Pages → `2d-szerkezto` → Settings → Variables and Secrets, Production: állítsd be a `SHOPIFY_STORE_DOMAIN` értékét a tényleges, protokoll nélküli `*.myshopify.com` domainre, a `SHOPIFY_STOREFRONT_ACCESS_TOKEN` értékét a Storefront tokenre. A `SHOPIFY_WEBHOOK_SECRET` értéke a webhookot aláíró Shopify app client secretje; Dashboardban létrehozott webhook esetén annak Shopify által megadott aláírási kulcsa. Titkokat ne írj a forráskódba. A meglévő `SHOP_DB`, `SHOP_ASSETS` és Access-változók változatlanok maradnak.
3. Shopifyban iratkoztasd fel az `orders/create` eseményt a `https://2d-szerkezto.pages.dev/api/shopify-webhook` HTTPS-címre, a fenti titokhoz tartozó feliratkozással. Ez nyilvánosan elérhető végpont kell legyen, nem `/api/admin/*` Access-védelem mögött; a nyers törzs HMAC-aláírását és a boltdomaint ellenőrzi. Az admin fájlok Access-védettek maradnak. A webhook az adott tételben kapott tervazonosító, termék- és variánsazonosító alapján összekapcsolja a rendelést.
4. A Shopify terméksablonban a „Termék személyre szabása” link célja `https://2d-szerkezto.pages.dev/szerkeszto/noi-neszeszer`. A Shopify témát ez a projekt nem módosítja.
5. Mentés és migrációállapot-ellenőrzés után alkalmazandó az új `0006_production_artwork.sql` D1-migráció, majd külön deploy szükséges. A migráció a fájltáblát átépíti és átmásolja a korábbi sorokat; nem futott le ebben a fejlesztési körben.

A „Tovább a vásárláshoz” előbb a meglévő D1/R2 rendszerbe menti a csomagot, azután a Storefront API `cartCreate` műveletével **új Shopify-kosarat** hoz létre egy tétellel és annak checkoutjára irányít. A Shopify-webshop böngészőben korábban meglévő kosarához ez nem fűzi hozzá a tételt. A line item properties a tervazonosítót és az Access-védett fájlhivatkozásokat tartalmazza; a fájlokat nem tárolja a Shopifyban. Sikertelen kosárkészítésnél a mentett terv megmarad és újrapróbálható. A webhook hiányában is visszakereshető a terv az azonosító alapján, de a rendelésazonosító nem töltődik ki automatikusan. Rendeléshez kapcsolt csomag törlése a Shopifyban lévő hivatkozásokat nem törli: a fájlok többé nem lesznek elérhetők.

Az admin igénylistában a megerősített törlés az adott csomag R2-fájljait, majd D1-rekordjait törli. Az R2 és D1 nem közös tranzakció: részleges hiba esetén az üzenet alapján a törlést újra kell próbálni. A webhook ismételt kézbesítése ugyanarra a rendelésre idempotens; elveszett vagy sikertelen értesítések visszapótlására automatikus szinkronizálás nincs.

```sh
npm run build
npm run test:designer
```

## Tartós tárhely

Éles Pages-konfiguráció mintája a `wrangler.toml.example`; a D1- és R2-azonosítókat nem ismerjük, ezért innen `wrangler.toml`-ként másolás után a tényleges Cloudflare-adatokkal kell kitölteni. A `SHOP_DB` D1 binding és a `SHOP_ASSETS` R2 binding neve egyezik az API-k által használt nevekkel. Ne használj másik projekt vagy webshop D1-adatbázisát.

A helyi Pages-futtatáshoz a `wrangler.local.toml` külön, Wrangler által emulált `roli-local` D1-adatbázist és `roli-local-assets` R2-bucketet definiál; itt a `npm run db:migrate:local` csak a helyi emulátor sémáját állítja be. A böngészős Vite fejlesztői szerver (`npm run dev`) továbbra is csak a frontend.

Éles telepítés előtt a Cloudflare Pages projekten állíts be `SHOP_DB` D1 bindingot és `SHOP_ASSETS` R2 bindingot a mintafájlban megadott, létező erőforrásokra. A termékkatalógust az `/api/designer-products` és az `/api/admin/designer-products`, a képeket és maszkokat az `/api/admin/assets` és `/api/assets/:assetId` útvonalak kezelik. A vásárlói igénylista a védett `/api/admin/designer-requests` útvonalat használja; a nyilvános beküldés továbbra is az `/api/designer-requests` POST. Az admin fájlelérés és -törlés az `/api/admin/*` útvonalakra került.

Cloudflare Accessben védd legalább a Pages domain `/termekek/*` és `/api/admin/*` útvonalait, és hozz létre adminisztrátori belépési szabályt. Az Access application team domain és audience értékét Pages-environment változóként (`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`) kell beállítani; helyben ezek `.dev.vars` fájlból olvashatók. A `.dev.vars` ne kerüljön verziókezelésbe.

Az adminoldal „Bejelentkezés” gombja a védett `/termekek/` útvonalat nyitja meg: az Access szükség esetén bejelentkeztet, majd az oldal újra lekéri a katalógust. Ha érvényes Access-munkamenettel is 401 jelentkezik, ellenőrizd az adminoldal és az admin API Access-lefedettségét, valamint a backend `CF_ACCESS_TEAM_DOMAIN` és `CF_ACCESS_AUD` értékét; a gomb önmagában nem javítja a hibás Access-konfigurációt.

A `migrations/` fájlok meglévő, sorrendben futtatandó migrációk. Éles adatbázison előbb ellenőrizd a migrációk állapotát és készíts mentést, mert itt sem a migrációk alkalmazása, sem éles adat módosítása nem történt. A `0004_customer_design_requests.sql` a tartós igénycsomag-táblákat hozza létre; ne futtasd újra azokat a migrációkat, amelyeket a Cloudflare már alkalmazottnak jelez.

A `0005_optional_material_prices.sql` a meglévő anyagindexben engedi a hiányzó helyi tesztárat, és a jelenlegi Shopify-azonosító mezőket indexeli. A hiányzó Shopify-ár nem nulla. Az új migrációt is csak a korábbiak állapotának ellenőrzése és mentés után szabad éles adatbázison alkalmazni.

## Fő modulok

- `src/designer-prototype/`: vásznas szerkesztő, profilok, anyagok, minták, terv beolvasása és exportja
- `src/designer-admin/`: termékadminisztráció, vásárlói igénylista, PNG/PDF/ZIP-csomagkészítés és helyi katalógus átvitele
- `src/data/designer-assets.ts`: helyi és tartós képtár
- `functions/api/`: szerkesztő-katalógus és képtár API
- `public/images/`: az alapértelmezett termékfotó, maszkok és anyagtextúrák
