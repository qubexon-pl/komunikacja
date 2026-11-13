# ON/WARD — instrukcja wdrożenia dla agenta (PL/EN)

## Cel
Wdroż dwujęzyczny interfejs **pl-PL** i **en-GB** w istniejącej aplikacji ON/WARD. Zachowaj wszystkie działające funkcje, API, wyszukiwanie tras, autoryzację i responsywność. Zmiana dotyczy tłumaczeń i prezentacji, a nie logiki podróży.

## Pliki źródłowe
- `i18n/pl-PL.json` — polskie etykiety, komunikaty, teksty dostępności.
- `i18n/en-GB.json` — angielskie odpowiedniki o identycznych kluczach.
- `AGENT_IMPLEMENTATION_GUIDE.md` — mapa użycia istniejących grafik SVG.
- `manifest.json` — rzeczywiste nazwy plików graficznych.
- `css/tokens.css` — kolory marki.

## Zasady obowiązkowe
1. **Nie tłumacz nazwy ON/WARD**, kodów IATA (`RZE`, `STN`), kodów tras ani nazw własnych. Tłumacz wyłącznie teksty interfejsu. Nie osadzaj tłumaczeń na stałe w SVG.
2. Wszystkie widoczne teksty, placeholdery, komunikaty błędów, powiadomienia, `aria-label`, opisy pustych stanów i podpisy ikon pobieraj z `t('sekcja.klucz')` (lub istniejącego w projekcie mechanizmu i18n).
3. Domyślnie `pl-PL`, jeśli język użytkownika jest polski; w innych przypadkach `en-GB`. Jeśli aplikacja ma już mechanizm wyboru języka, zachowaj go. Ręczny wybór ma pierwszeństwo przed automatycznym.
4. Dodaj przełącznik **PL / EN** w nawigacji, a na telefonie również w menu mobilnym. Zachowuj wybór w istniejącym profilu użytkownika lub `localStorage`, jeśli profil nie przechowuje preferencji.
5. Ustaw `document.documentElement.lang` odpowiednio na `pl` albo `en`. Stosuj `Intl.DateTimeFormat` i `Intl.NumberFormat` dla dat, cen, jednostek i liczb; nie zastępuj danych tłumaczeniami.
6. W języku polskim używaj np. „Zaplanuj podróż”, „Skąd?”, „Dokąd?”, „W jedną stronę”, „W obie strony”, „Szukaj”, „Moje podróże”, „Ulubione”.
7. Dla `peopleCount`, `resultsCount` i innych liczb używaj poprawnej polskiej odmiany (ICU plural lub własna funkcja zgodna z CLDR), a nie tylko podstawienia `{count}`.
8. Zastosuj odpowiednie szerokości i zawijanie etykiet; nie obcinaj „Komunikacja podmiejska” ani „Lotniska w promieniu 300 km”.
9. Grafiki pozostają identyczne w obu językach. `logos/wordmark-light.svg` na ciemnym pasku, `logos/wordmark-dark.svg` na jasnym tle, transport `icons/*.svg`, hero `banners/coast.svg`, puste wyniki `illustrations/no-results.svg`. Szczegóły w angielskim przewodniku.
10. Tekst alternatywny dla czysto dekoracyjnych grafik ma być pusty (`alt=""`); dla funkcjonalnych ikon przyciski mają dostępne etykiety z i18n.

## Mapa komponentów
| Komponent | Klucze | Grafiki |
|---|---|---|
| Pasek nawigacji | `nav.*`, `common.language` | `logos/wordmark-light.svg`, `icons/heart.svg`, `icons/alert.svg` |
| Hero i pogoda | `hero.*`, `weather.*` | `banners/coast.svg`, `icons/sun.svg`, `icons/cloud.svg` |
| Formularz podróży | `search.*`, `modes.*` | `icons/pin.svg`, `icons/calendar.svg`, `icons/users.svg`, `icons/search.svg` |
| Filtry transportu | `modes.*` | `icons/plane.svg`, `icons/bus.svg`, `icons/train.svg`, `icons/car.svg` |
| Wyniki połączeń | `results.*`, `common.*` | `icons/route.svg`, `icons/ticket.svg`, `icons/suitcase.svg` |
| Kierunki | `destinations.*` | `banners/city.svg`, `banners/mountains.svg` |
| Moje podróże | `myTrips.*` | `illustrations/trip-saved.svg`, `illustrations/ready-to-go.svg` |
| Brak wyników | `results.noResults*` | `illustrations/no-results.svg` |

## Przykład (React + i18next)
```tsx
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import pl from './assets/onward/i18n/pl-PL.json';
import en from './assets/onward/i18n/en-GB.json';

i18n.use(initReactI18next).init({
  resources: { 'pl-PL': { translation: pl }, 'en-GB': { translation: en } },
  lng: localStorage.getItem('onward.locale') || (navigator.language.toLowerCase().startsWith('pl') ? 'pl-PL' : 'en-GB'),
  fallbackLng: 'en-GB',
  interpolation: { escapeValue: false }
});
export default i18n;
```
W istniejącej aplikacji **najpierw sprawdź**, czy i18n już działa, i integruj się z obecnym rozwiązaniem zamiast instalować drugie. Powyższy kod to przykład, nie obowiązkowa architektura.

## Kontrola jakości
- Sprawdź widok desktop i mobile w obu językach; brak nachodzących na siebie etykiet.
- Przełącz język bez przeładowania i bez utraty wpisanych danych formularza.
- Zachowaj wartości pogody, ceny i tras; zmienia się wyłącznie format i opis.
- Sprawdź klucze w obu JSON, fallback dla brakujących tłumaczeń i brak surowych identyfikatorów kluczy w UI.
- Przetestuj wyszukiwanie, filtry, zapis podróży, błędy API i puste wyniki.
- Nie odwołuj się do zdjęć z moodboardów jako do plików w paczce — dostępne bannery to SVG.
