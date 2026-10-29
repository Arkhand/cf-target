---
name: cf-target
description: |
  Which Cloud Foundry account a project uses, and how to run `cf` against it without ever
  touching another client's subaccount. Use whenever a task touches Cloud Foundry / SAP BTP CF
  in a project: deploy (cf deploy, cf push, MTA/mtar), services, service keys, apps, logs, env,
  routes, cf login/target — or the user asks which account, subaccount, org or space a project
  works against. Raw `cf` is blocked by the cf-guard hook: always `cf-target -- <args>`.

  Keywords: cloud foundry, cf, btp, deploy, mta, mtar, cf push, subaccount, org, space,
  cf target, cf login, service key.
---

# cf-target — la cuenta de Cloud Foundry de cada proyecto

Cada proyecto declara su cuenta en un archivo `.cf-target` en su raíz (gitignored):

```ini
api   = https://api.cf.us10-001.hana.ondemand.com
org   = my-org
space = dev
user  = you@company.com
auth  = password          # password | sso
```

`cf-target` corre `cf` **solo** contra esa cuenta: sesión aislada por ejecución, login con la
contraseña guardada en el Credential Manager de Windows, y verifica usuario, org y space antes de
correr nada. Dos repos pueden deployar a la vez, cada uno a su cuenta.

## Regla

**Nunca `cf` directo.** El hook `cf-guard` lo bloquea igual. Todo comando de CF va así:

```
cf-target -- <args de cf>        ej.: cf-target -- deploy mta_archives/app_1.0.0.mtar -f
```

Si `cf-target` no está en el PATH: no adivines la ruta; pedile al usuario que corra `npm link` en
su clon de cf-target.

## Paso 1: ¿qué cuenta usa este proyecto?

```
cf-target show --json
```

- `ok:true` → `target` dice api/org/space/usuario; `session` dice si hay sesión; `passwordStored`
  si hay contraseña guardada. Mostrale la cuenta al usuario antes de cualquier escritura.
- código 2 (no hay `.cf-target`) → Paso 2.

## Paso 2: el proyecto no tiene `.cf-target` → proponerlo

Pasa en un proyecto nuevo, o en uno viejo cuando se pide un deploy o algo de CF.

1. Buscá la cuenta en el contexto del proyecto: su `CLAUDE.md`, `memory/`, `mta.yaml`,
   `xs-security.json`, README, `default-env.json`, lo que el usuario dijo. Necesitás api, org,
   space, usuario y si el login es por contraseña o SSO.
2. Si falta org/space y el usuario ya tiene contraseña guardada para ese api+usuario:
   `cf-target targets --api <api> --user <usuario> --json` lista los reales.
3. **Mostrale el archivo propuesto y esperá su OK.** No lo crees solo.
4. Con el OK:
   ```
   cf-target init --api <api> --org "<org>" --space <space> --user <usuario> --auth password|sso --json
   ```
   Verifica contra CF (si hay sesión o contraseña), escribe `.cf-target` y lo agrega al `.gitignore`.
   `verified:false` con `warning` = se escribió pero falta login (Paso 3).
   Código 6 = el org/space no existe para ese usuario: no se escribió; revisá los valores.

## Paso 3: login

Claude **nunca** pide ni maneja la contraseña en el chat. Si un comando devuelve código 4, pedile
al usuario que corra en la terminal de esta sesión:

```
! cf-target login
```

- `auth = password`: la tipea él (sin eco), `cf` la valida y queda guardada en el Credential Manager
  (`cf-target:<api>:<usuario>`). Desde ahí, cuando la sesión vence, `cf-target` se loguea solo.
- `auth = sso`: hace falta el passcode de `https://login.cf.<región>.hana.ondemand.com/passcode`.
  Si el usuario te pasa el passcode: `cf-target login --sso-passcode <code> --json`.

## Códigos de salida

| Código | Qué pasó | Qué hacer |
|---|---|---|
| 2 | No hay `.cf-target` / argumentos mal | Paso 2 |
| 4 | Sin sesión (y sin contraseña guardada, o SSO) | Paso 3 |
| 6 | El org/space del archivo no existe para ese usuario | Mostrarlo; no cambiar de cuenta por tu cuenta |
| 7 | La sesión es de otro usuario/api que el archivo | Mostrarlo; no "arreglarlo" cambiando de cuenta |
| otro | Código del propio `cf` (en `cf-target -- …`) | Leer la salida de `cf` |

## Sistemas vivos

Antes de deployar, crear/borrar servicios o keys, `update-service`, o escribir destinations:
listá qué se va a tocar **con la cuenta** (`api / org / space`, del banner `[cf-target] …` o de
`show`) y esperá confirmación. Ante un error de lock o de permisos: parar y reportar, no reintentar.

## Scripts que llaman a `cf` por dentro

El hook no ve un `cf` adentro de `npm run deploy`, `mbt`, `make` o un `.cmd`. Antes de correr uno,
mirá qué comandos de `cf` ejecuta y corré esos mismos con `cf-target -- …` (p.ej. `mbt build` sí,
y después `cf-target -- deploy <mtar> -f`).

## Ver / cambiar la cuenta

- Ver: `cf-target show` (o abrir `.cf-target`).
- Cambiar: editar `.cf-target` o `cf-target init --force …`, siempre con OK del usuario.
- Olvidar la contraseña guardada: `cf-target forget`.
