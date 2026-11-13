# Cocos backend

API REST en NestJS y PostgreSQL para consultar el portfolio de un usuario, buscar activos y enviar
o cancelar órdenes. Requiere Node.js 22 o superior y PostgreSQL.

## Puesta en marcha

1. Crear dos bases locales: `cocos` (desarrollo) y `cocos_test` (pruebas).
2. Copiar `.env.example` a `.env` y ajustar `DATABASE_URL` y `TEST_DATABASE_URL`.
3. Instalar, crear el esquema, cargar los datos del challenge y levantar la API:

```sh
npm install
npm run db:setup
npm run start:dev
```

`db:setup` aplica `sql/001_schema.sql` y carga los INSERT de `sql/database.sql` (el SQL original
del challenge). El seed no hace nada si la base ya tiene datos. Por seguridad, los scripts de base
de datos y los tests solo aceptan conexiones a localhost.

## Endpoints

Base: `http://localhost:3000/api/v1`. Hay ejemplos ejecutables en `requests.http` (REST Client).

| Método | Ruta                                    | Uso                                        |
| ------ | --------------------------------------- | ------------------------------------------ |
| GET    | `/users/:userId/portfolio`              | Valor total, pesos disponibles, posiciones |
| GET    | `/instruments?q=YPF&limit=20&offset=0`  | Búsqueda por ticker o nombre               |
| POST   | `/users/:userId/orders`                 | Enviar una orden de compra o venta         |
| GET    | `/users/:userId/orders/:orderId`        | Consultar una orden                        |
| PATCH  | `/users/:userId/orders/:orderId/cancel` | Cancelar una orden LIMIT pendiente         |

Ejemplo de orden:

```json
{ "instrumentId": 47, "side": "BUY", "type": "LIMIT", "amount": "2000.00", "price": "900.00" }
```

Se envía exactamente uno de `size` (cantidad entera de acciones) o `amount` (monto en pesos).
`price` es obligatorio en LIMIT y no se acepta en MARKET. No hay autenticación, según la consigna;
el usuario viene en la ruta.

## Decisiones de diseño

**Estructura.** `src/domain` contiene las reglas (saldos, evaluación de órdenes, valuación) sin
dependencias de Nest ni de PostgreSQL. `src/application` orquesta los casos de uso y define el
puerto de persistencia. `src/infrastructure` tiene los adaptadores HTTP y PostgreSQL (SQL directo
con `pg` y parámetros `$1, $2…`).

**Órdenes.**

- MARKET se ejecuta al último `close` y queda FILLED. LIMIT usa el precio enviado y queda NEW.
  No se simula el mercado: las LIMIT no se ejecutan solas.
- Con `amount` se compra la máxima cantidad entera de acciones: `floor(amount / price)`.
  Si el monto no alcanza para una acción, se responde 422 sin crear la orden.
- Si faltan pesos (compra) o acciones (venta), la orden se guarda como REJECTED con su motivo
  (`INSUFFICIENT_FUNDS` o `INSUFFICIENT_SHARES`) y se responde 201.
- Las órdenes NEW reservan pesos (compra) o acciones (venta), para no comprometer dos veces lo
  mismo. Cancelar libera la reserva. Solo se cancelan órdenes NEW; cancelar dos veces devuelve
  la orden ya cancelada.
- Pedidos mal formados devuelven 400; usuario, instrumento u orden inexistentes, 404.

**Concurrencia.** Crear y cancelar órdenes corre en una transacción con `SELECT … FOR UPDATE`
sobre el usuario. Así dos órdenes simultáneas del mismo usuario no pueden gastar el mismo saldo,
incluso con varias instancias de la API. Las lecturas no esperan ese bloqueo.

**Idempotencia (opcional).** Si el POST trae el header `Idempotency-Key`, un reintento con la misma
clave y el mismo cuerpo devuelve la orden original en vez de crear otra; con otro cuerpo responde 409. Protege contra órdenes duplicadas por reintentos de red, que es un problema distinto del
sobregiro que resuelve el bloqueo. Sin el header, cada POST crea una orden.

**Portfolio.**

- Pesos: suma de CASH_IN y CASH_OUT (`size` en pesos) y de compras y ventas FILLED
  (`size * price`). `availableCash` descuenta las reservas de órdenes NEW.
- Posiciones: solo órdenes FILLED. El rendimiento usa el costo promedio ponderado de las
  acciones que siguen en cartera. También se informa el retorno diario (`close` vs
  `previousClose`).
- `totalValue` = pesos + valor de mercado de las posiciones.
- Una posición sin cotización se lista con valor y rendimiento `null` y no suma al total, en vez
  de hacer fallar todo el portfolio.
- El seed tiene una posición negativa en el instrumento 31 (compra 20, vende 30). Se muestra tal
  cual, con costo y rendimiento `null`. La API no permite vender más de lo que se tiene.
- Cada consulta carga en memoria las órdenes del usuario y las cotizaciones. Alcanza para este
  volumen; a escala convendría agregar en SQL o mantener una tabla de posiciones.

**Importes.** Se calculan con `decimal.js` y se devuelven como strings con dos decimales para no
perder precisión. Las fechas de las órdenes se guardan en UTC.

**Cambios en la base.** La migración agrega:

- `orders.rejection_reason`, para saber por qué se rechazó una orden;
- la tabla `order_requests`, para la idempotencia;
- un índice `orders(userid, status, instrumentid)`, para los cálculos de saldo;
- un índice `marketdata(instrumentid, date DESC)`, para obtener la última cotización.

Se mantienen los nombres de tablas y columnas originales.

## Pruebas y calidad

```sh
npm test                 # Unitarias del dominio y la validación
npm run test:integration # HTTP contra PostgreSQL real
npm run check            # Formato, lint, tipos, build y ambas suites
```

Los tests de integración usan solo `TEST_DATABASE_URL` (nunca la base de desarrollo), crean un
esquema temporal y lo eliminan al terminar. Si la variable no está definida, la suite se omite.
Cubren el envío de órdenes (MARKET, LIMIT, por monto, rechazos, reservas, errores de negocio,
concurrencia, rollback), la idempotencia, la cancelación, el portfolio y la búsqueda.
