# Анализ прогона (пример вывода скилла)

> Этот файл имитирует MD, который готовит скилл анализа логов Jenkins.
> Его подключают командой `pw-extended-report add-analysis --file ai-analysis.md`:
> он появляется во вкладке **Failure analysis** над автоматической группировкой.

## Итоги

| Метрика | Значение |
|---|---|
| Всего тестов | 9 |
| Упало | 5 (55.6%) |
| Flaky | 1 |
| Пропущено | 1 |

## Повторяющиеся ошибки

### 1. Нет элемента `data-testid="cart-counter"` — 3 теста

Вероятная причина: на фронте переименовали `data-testid` счётчика корзины.

- [adds item to cart](#?test=cart%20%E2%80%BA%20adds%20item%20to%20cart)
- [removes item from cart](#?test=removes%20item%20from%20cart)
- [cart survives reload](<#?test=cart › cart survives reload>)

<details>
<summary>Фрагмент лога Jenkins</summary>

```text
Error: expect(locator).toHaveText(expected) failed
Locator: getByTestId('cart-counter')
Expected: "Cart: 1"
Timeout: 1000ms
Error: element(s) not found
```

</details>

### 2. Неверный расчёт суммы — 1 тест

- [total is calculated](#?test=total%20is%20calculated)

### 3. Нестабильный виджет оплаты (flaky)

- [flaky payment widget](#?test=flaky%20payment%20widget) — упал на первой попытке, прошёл на ретрае.

## Рекомендации

- [ ] Согласовать с фронтом новый `data-testid` для счётчика корзины.
- [ ] Проверить формулу расчёта итоговой суммы.
- [ ] Добавить ожидание загрузки виджета оплаты.

Быстрые фильтры: [все упавшие](#?q=s:failed) · [flaky](#?q=s:flaky) · [вкладка Insights](#?tab=insights)
