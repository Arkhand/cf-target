---
name: cf-proxy
description: |
  Run or reuse cf-proxy, the local proxy to SAP BTP destinations, for the project's Cloud Foundry
  account. Use when a project needs to reach BTP destinations from this PC: start or check the
  proxy, point ui5.yaml / Postman / a script at it, test a destination, see which proxies are
  running, or log in as the end user for PrincipalPropagation / OAuth2UserTokenExchange.
  Also opens tunnels to services that only CF can reach (PostgreSQL on BTP), for running a CAP
  app locally in hybrid mode or a SQL client against the BTP database.
  The account comes from the project's `.cf-target` (skill cf-target).

  Keywords: cf-proxy, destination, BTP destination, ui5.yaml proxy, localhost:3100,
  principal propagation, user token exchange, on-premise, cloud connector, postgres tunnel,
  postgresql-db, cds hybrid, default-env, cf ssh tunnel.
---

# cf-proxy — el proxy local a las destinations del proyecto

`cf-proxy` levanta `http://localhost:<puerto>/<DESTINATION>/<path>` contra las destinations de una
subcuenta. Cada subcuenta tiene un **perfil** con su puerto; las corridas quedan en segundo plano y
cualquier sesión las ve.

CLI: `cf-proxy <comando> --json` (queda en el PATH con `npm link` en el clon de CF-proxy). Si no
está en el PATH: no adivines la ruta; pedile al usuario que corra `npm link` ahí.

## Paso 1: la cuenta del proyecto

```
cf-target show --json
```

Sin `.cf-target` → seguí la skill **cf-target** (Paso 2) antes de nada.

## Paso 2: el perfil de esa subcuenta

```
cf-proxy profiles list --json
```

Buscá el perfil con el mismo `api` (sin importar mayúsculas ni `/` final) y el mismo `org` que el
`.cf-target`. Hay a lo sumo uno (una subcuenta = un perfil).

- No hay → proponé crearlo y esperá OK: `cf-proxy profiles add --from-target --title "<título>" --json`
  (toma api/org/space/usuario del `.cf-target`, puerto libre).
- Tiene `problems` → mostralos; se arreglan con `cf-proxy profiles edit <p> ...` y OK del usuario.

## Paso 3: ¿ya corre?

```
cf-proxy ps --json
```

Si el perfil está en `runs` con `status: "ok"`, usá su `url`. **No lo arranques de nuevo.**

Si no: `cf-proxy start <perfil> --json` → `{url, already}`. Es idempotente: si otra sesión lo
arrancó al mismo tiempo, devuelve el mismo.

| Código | Qué pasó | Qué hacer |
|---|---|---|
| 2 | Perfil inexistente o con problemas | Paso 2 |
| 3 | Ya corre pero no responde | `cf-proxy logs <p>`; detener solo con OK del usuario |
| 4 | Sin sesión de cf | Pedir `! cf-target login` en ese proyecto (comparte la sesión) |
| 5 | Puerto ocupado por otro programa | Avisar; no cambiar puertos sin OK |
| 6 | Faltan los recursos `cf-dest-*` en el space | Proponer el deploy y esperar OK |
| 7 | La sesión es de otro usuario, o el `.cf-target` de la carpeta es otra cuenta | Mostrarlo; en el proyecto usar `cf-target -- …`, no cambiar de cuenta |

Comandos de `cf` del proyecto: siempre `cf-target -- …`. `cf-proxy cf <perfil> -- …` existe para quien
no tiene cf-target, y desde una carpeta con `.cf-target` de otra cuenta se niega (7).

## Login de usuario (PrincipalPropagation / OAuth2UserTokenExchange)

En `ps --json`, `login.loggedIn: false` con `configured: true` = falta. Si el proyecto usa esas
destinations, pasale al usuario `login.url` para que lo abra en el browser. Si `login.warning`
dice que el puerto no está en las redirect-uris, el login va a fallar: avisalo (arreglarlo es un
`update-service` del XSUAA de esa subcuenta, sistema vivo, con OK).

## Usarlo

- `ui5.yaml`: `url: http://localhost:<puerto>` con `pathPrefix: /<DESTINATION>/...`.
- Probar una destination: `GET <url>__test/<DESTINATION>`.
- Ver destinations: `GET <url>__destinations`.

## Qué levantar

| El proyecto necesita | Levantar |
|---|---|
| Llamar destinations (S/4 on-premise, APIs de Internet) desde una app local, ui5.yaml o un script | El **proxy** del perfil (Paso 3) |
| Conectarse a una base de BTP (`postgresql-db`) desde la PC | Un **túnel** (abajo) |
| Correr un CAP local contra BTP (un profile tipo `[hybrid]` o `[local-proxy]`) que lee S/4 y usa PostgreSQL | **Los dos** |

Para saber qué usa un CAP: en `mta.yaml`, un resource con `service: postgresql-db` (o
`existing-service` con ese offering) es la base; `cds.requires` en `package.json` dice qué
remotos usan `destination`. Si un profile de `package.json` ya apunta a `localhost:<puerto>`, ese es el puerto
que espera.

## Túneles a servicios (PostgreSQL)

`localhost:<puerto>` → host interno de una instancia, por `cf ssh` a través de una app del space.
Config aparte de los perfiles; el host se lee de los bindings al arrancar (no crea keys).

1. `cf-proxy tunnels list --json` → buscá el de ese `profile` y ese `service` (nombre de la instancia).
2. No hay → proponé crearlo y esperá OK:
   `cf-proxy tunnels add --name <perfil>-pg --profile <perfil> --service <instancia> [--port N] --json`
   (sin `--port`: el primero libre desde 15432; si el proyecto ya espera un puerto, usá ese).
3. `cf-proxy ps --json` → si está en `tunnels` con `status: "ok"`, usalo. **No lo arranques de nuevo.**
4. Si no: `cf-proxy tunnels start <t> --json` → `{port, remote, app, already}`. Idempotente.
   Mismos códigos de salida que `start`; el motivo de un fallo está en `cf-proxy tunnels logs <t>`.

El túnel solo cambia host y puerto: usuario, contraseña y certificados son los del binding.
**CAP hybrid:** CAP siempre pisa los `credentials` de `package.json` con los de `VCAP_SERVICES`,
así que con `default-env.json` (de `cf-target -- default-env <app>`) hay que poner
`hostname: localhost` y `port: <puerto del túnel>` en la entrada `postgresql-db` de ese archivo.
`cf default-env` lo vuelve a pisar cada vez que se corre.

## Reglas

- Nunca detener un proxy ni un túnel que no arrancaste vos en esta tarea, salvo pedido explícito.
- Un CAP en hybrid contra la base de dev **escribe en una base compartida**: avisalo antes de correr
  acciones que escriben.
- Crear, editar o borrar destinations (desde la página o la API) es escribir en un sistema vivo:
  listá qué se toca y esperá OK.
- Nunca pidas contraseñas en el chat.
