# STALZONE Server Directory

Статический сайт GitHub Pages с автоматическим обновлением списка серверов через GitHub Actions.

## Источники

Workflow запрашивает только актуальные региональные endpoint’ы:

- EU — `https://backend-eu.stalzone.com/address_list?login=Hi`
- NA — `https://backend-na.stalzone.com/address_list?login=Hi`
- SEA — `https://backend-sea.stalzone.com/address_list?login=Hi`
- NEA — `https://backend-nea.stalzone.com/address_list?login=Hi`
- RU — `https://backend.stalcraftx.ru/address_list?login=Hi`

Старый статический список серверов не используется.

## Развёртывание

1. Создайте новый репозиторий GitHub.
2. Загрузите в него всё содержимое этой папки, сохранив структуру каталогов.
3. Основная ветка должна называться `main` или `master`.
4. Откройте **Settings → Pages**.
5. В разделе **Build and deployment → Source** выберите **GitHub Actions**.
6. Откройте вкладку **Actions**.
7. Выберите workflow **Update STALZONE servers and deploy Pages**.
8. Нажмите **Run workflow** для первого запуска.
9. После успешного выполнения адрес страницы появится в шаге Deploy и в Settings → Pages.

## Обновление

Workflow запускается:

- после push в `main` или `master`;
- вручную через `workflow_dispatch`;
- автоматически на 7-й, 22-й, 37-й и 52-й минуте каждого часа.

Страница загружает `public/data/servers.json`. Кнопка «Проверить обновление» перечитывает последний уже опубликованный снимок с отключённым браузерным кэшем.

## Поведение при ошибках

- Ошибка одного региона отображается на странице; остальные регионы публикуются.
- Если недоступны все endpoint’ы, workflow завершается ошибкой.
- В этом случае предыдущий успешный GitHub Pages deployment остаётся опубликованным.
- Данные не подменяются старыми адресами из сторонних списков.

## IP-данные

Кнопка «Загрузить IP-данные» выполняется в браузере пользователя через `ipwho.is` и сохраняет результат в `localStorage`. Список серверов от этого сервиса не зависит.

## Локальная проверка

Из корня проекта:

```bash
node scripts/fetch-servers.mjs
python -m http.server 8000 --directory public
```

После этого откройте `http://localhost:8000`.
