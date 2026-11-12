# Cocos backend

API NestJS con arquitectura hexagonal y PostgreSQL. Node.js 22 o superior.

## Desarrollo local

En este entorno PostgreSQL 16 está instalado y activo en `127.0.0.1:5432`.
Las bases `cocos` (desarrollo) y `cocos_test` (pruebas) usan el usuario y contraseña locales `postgres`.
El `.env` ya apunta a ambas bases locales. En una instalación nueva, copiar `.env.example` a `.env`
y crear ambas bases antes de ejecutar los scripts.

```sh
npm install
npm run db:setup
npm run check
npm run start:dev
```

`db:setup` aplica `sql/001_schema.sql` y carga las sentencias INSERT de `sql/database.sql`,
el SQL original del challenge. El seed se omite si alguna tabla ya tiene datos: no borra ni reemplaza registros.
`db:migrate` es repetible y registra las migraciones aplicadas. `db:inspect` muestra el esquema y los conteos.
Los scripts de migración, seed e inspección rechazan conexiones que no sean a localhost o una dirección de loopback.
No hay migraciones automáticas al arrancar la API.

Si `node` o `npm` no están en el PATH de esta sesión, el runtime descargado está disponible con:

```sh
export PATH=/tmp/node-v24.22.3-linux-x64/bin:$PATH
```

Para iniciar PostgreSQL después de reiniciar este entorno: `sudo pg_ctlcluster 16 main start`.
Los datos persisten en el cluster local de PostgreSQL, fuera de `/tmp`.

## Pruebas

```sh
npm run typecheck
npm run build
npm test
npm run test:integration
```

`check` verifica el formato y el lint, y ejecuta los cuatro pasos. La integración usa exclusivamente `TEST_DATABASE_URL`, debe ser local,
y crea un esquema temporal que elimina al terminar. Nunca toma `DATABASE_URL` como alternativa.
Si no está definida `TEST_DATABASE_URL`, la suite se marca como omitida.
Se prueban endpoints HTTP contra PostgreSQL real: validación, concurrencia, idempotencia,
reservas, cancelaciones, rechazo persistido, rollback y búsqueda.
Las pruebas no alteran los movimientos del seed de `cocos`.

## Endpoints

Base: `http://localhost:3000/api/v1`.

| Método | Ruta                                    | Uso                                                    |
| ------ | --------------------------------------- | ------------------------------------------------------ |
| GET    | `/users/:userId/portfolio`              | Saldo, reservas, posiciones y rendimientos             |
| GET    | `/instruments?q=YPF&limit=20&offset=0`  | Búsqueda por ticker o nombre                           |
| POST   | `/users/:userId/orders`                 | Crear compra o venta con `Idempotency-Key` obligatorio |
| GET    | `/users/:userId/orders/:orderId`        | Consultar el estado actual                             |
| PATCH  | `/users/:userId/orders/:orderId/cancel` | Cancelar una LIMIT pendiente                           |

Ejemplos ejecutables en `requests.http` para REST Client. No se implementa autenticación, según la consigna.
El usuario viene explícitamente en la ruta.

## Decisiones de diseño

- `src/domain`: órdenes, disponibilidad y valuación, sin dependencias de Nest ni PostgreSQL.
- `src/application`: casos de uso y puertos de persistencia.
- `src/infrastructure`: adaptadores HTTP y PostgreSQL. `AppModule` conecta los puertos con sus implementaciones.
- Crear y cancelar órdenes usa `withUserTransaction`: una transacción y `SELECT ... FOR UPDATE` sobre la fila del usuario.
  El bloqueo serializa compras, ventas y cancelaciones del mismo usuario entre procesos o réplicas de la API.
  Todos los escritores deben respetar ese protocolo.
  Las lecturas usan `readUser`, una transacción de solo lectura con snapshot consistente, sin bloquear al usuario.
- La orden y su registro de idempotencia se guardan en la misma transacción. La clave es única por usuario.
  Repetir clave y contenido devuelve la respuesta original; cambiar el contenido devuelve 409.
  Los importes se normalizan antes de calcular el hash. No hay expiración automática de claves.
  Tras una cancelación, repetir el POST sigue devolviendo la respuesta original; el GET muestra el estado actual.
- MARKET usa el último `close` por fecha e ID. LIMIT usa el precio indicado, queda NEW y reserva fondos o acciones.
  Cancelar libera la reserva. No hay motor de ejecución de LIMIT ni simulación de mercado.
- Las insuficiencias de saldo o acciones se guardan como REJECTED, con HTTP 201 y motivo de rechazo.
  Los pedidos mal formados devuelven 400 sin crear una orden. Los recursos inexistentes devuelven 404.
- Se exige exactamente uno de `size` entero o `amount`. El monto se divide por el precio y se redondea hacia abajo.
  MARKET no acepta precio; LIMIT lo requiere. Los importes usan Decimal y se devuelven como strings.
- CASH_IN y CASH_OUT usan `size` como cantidad de pesos; las compras y ventas usan `size * price`.
  Solo FILLED afecta las tenencias efectivas; NEW reduce lo disponible mediante reservas.
- El valor total incluye efectivo y posiciones; las reservas no se descuentan del patrimonio dos veces.
  El rendimiento de la posición usa costo promedio ponderado restante después de ventas.
  Se informa también el retorno diario a partir de `close` y `previousClose`.
- El seed contiene una posición negativa en el instrumento 31: compra 20 y vende 30.
  Se conserva el dato y se muestra la posición negativa; su costo y rendimiento porcentual se devuelven como null.
  No se permite vender más acciones disponibles desde la API.
- La migración agrega `orders.rejection_reason`, `order_requests`, `schema_migrations` y dos índices;
  mantiene los nombres originales de columnas en minúsculas y `marketdata.date`.

Las credenciales del entorno se guardan en `.env`, excluido del repositorio.

## Formato y lint

```sh
npm run format        # Aplicar Prettier
npm run format:check  # Verificar formato
npm run lint          # Verificar ESLint
npm run lint:fix      # Aplicar correcciones automáticas
```

ESLint usa las reglas recomendadas para TypeScript y `eslint-config-prettier` para evitar conflictos de formato.
Los IDs de ruta se convierten con `ParseIntPipe` de Nest. El header de idempotencia solo exige presencia
y hasta 128 caracteres, sin restricciones adicionales de formato. Las validaciones de órdenes permanecen
en el cuerpo del pedido.

## Prevención de SQL injection

Los valores de la API se pasan a PostgreSQL como parámetros (`$1`, `$2`, etc.) separados del SQL.
Las partes interpoladas en el SQL son constantes internas: columnas de respuesta y la cláusula de bloqueo.
Los nombres de tablas y columnas no se reciben desde el cliente. No se usa un middleware que filtre
palabras SQL ni se modifican los datos del usuario para quitar comillas.

Las pruebas HTTP de integración cubren payloads en búsquedas, IDs, campos de órdenes y claves de idempotencia.
También verifican que nombres válidos con apóstrofes o palabras SQL se puedan buscar y que los intentos
de inyección no cambien los usuarios ni creen órdenes mediante pedidos inválidos.

Referencia: [OWASP SQL Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet).
