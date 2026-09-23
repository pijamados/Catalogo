/**
 * Worker de Pijamados - Catálogo
 * ----------------------------------
 * Este código corre en Cloudflare, NO en el navegador.
 * Es el único lugar donde vive el token de GitHub, así nunca queda
 * expuesto en una página web.
 *
 * Variables/secretos que hay que configurar en Cloudflare (Settings > Variables):
 *   - GITHUB_TOKEN     (secreto) -> Fine-grained PAT con permiso Contents: Read & write
 *   - ADMIN_PASSWORD   (secreto) -> la clave del panel de administración
 *   - GITHUB_REPO      (texto)   -> "usuario/nombre-del-repo"
 *   - GITHUB_BRANCH    (texto)   -> "main"
 *
 * Las categorías (Pijamas, Remeras, Mantas, etc.) viven en categorias.json.
 *
 * Cada producto en products.json tiene esta forma:
 *   {
 *     imagen: "pijama-dino_123.jpg",   // FOTO DE PORTADA, identifica al producto, no cambia salvo que se elija otra portada
 *     galeria: ["pijama-dino_123_1.jpg", "pijama-dino_123_2.jpg"],  // fotos adicionales (opcional)
 *     nombre: "Pijama Dino",
 *     precio: 15000,
 *     descripcion: "Pijama de algodón manga larga",
 *     categoria: "varon" | "mujer",     // género
 *     talles: ["6", "8", "10"]          // talles disponibles en stock
 *   }
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function limpiarTexto(texto) {
  return texto
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function limpiarTalles(talles) {
  if (!Array.isArray(talles)) return [];
  const permitidos = ["6", "8", "10", "12", "14", "16"];
  return talles.map((t) => String(t).trim()).filter((t) => permitidos.includes(t));
}

async function githubRequest(env, path, options = {}) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "pijamados-catalogo-worker",
      Accept: "application/vnd.github+json",
      ...(options.headers || {}),
    },
  });
  return resp;
}

async function getFile(env, path) {
  const resp = await githubRequest(env, path);
  if (resp.status === 404) return { exists: false, content: null, sha: null };
  if (!resp.ok) throw new Error(`No se pudo leer ${path}: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return { exists: true, sha: data.sha, contentBase64: data.content };
}

async function putFile(env, path, contentBase64, message, sha) {
  const body = {
    message,
    content: contentBase64,
    branch: env.GITHUB_BRANCH || "main",
  };
  if (sha) body.sha = sha;
  const resp = await githubRequest(env, path, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`No se pudo guardar ${path}: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function deleteFile(env, path, sha, message) {
  const resp = await githubRequest(env, path, {
    method: "DELETE",
    body: JSON.stringify({ message, sha, branch: env.GITHUB_BRANCH || "main" }),
  });
  return resp.ok;
}

function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function fromBase64Utf8(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function leerProductos(env) {
  const file = await getFile(env, "products.json");
  if (!file.exists) return { productos: [], sha: null };
  const texto = fromBase64Utf8(file.contentBase64);
  return { productos: JSON.parse(texto), sha: file.sha };
}

async function guardarProductos(env, productos, sha, mensaje) {
  const contenido = toBase64Utf8(JSON.stringify(productos, null, 2));
  return putFile(env, "products.json", contenido, mensaje, sha);
}

function checkPassword(env, password) {
  return password && password === env.ADMIN_PASSWORD;
}

// Sube varias fotos nuevas (archivos siempre nuevos => nunca hay conflicto de sha) y devuelve sus nombres finales
async function subirFotos(env, nombreProducto, fotos) {
  const nombres = [];
  for (let i = 0; i < fotos.length; i++) {
    const f = fotos[i] || {};
    if (!f.base64) continue;
    const ext = (f.ext || "jpg").replace(".", "");
    const nombreArchivo = `${limpiarTexto(nombreProducto)}_${Date.now()}_${i}.${ext}`;
    await putFile(env, `img/${nombreArchivo}`, f.base64, `Sube foto: ${nombreProducto}`, null);
    nombres.push(nombreArchivo);
  }
  return nombres;
}

async function borrarFoto(env, nombreArchivo) {
  const archivo = await getFile(env, `img/${nombreArchivo}`);
  if (archivo.exists) await deleteFile(env, `img/${nombreArchivo}`, archivo.sha, `Elimina foto: ${nombreArchivo}`);
}

const CATEGORIAS_DEFAULT = [
  { id: "pijamas", nombre: "Pijamas", genero: true, talles: true },
  { id: "remeras", nombre: "Remeras", genero: true, talles: true },
  { id: "mantas", nombre: "Mantas", genero: false, talles: false },
];

async function leerCategorias(env) {
  const file = await getFile(env, "categorias.json");
  if (!file.exists) return { categorias: CATEGORIAS_DEFAULT, sha: null };
  return { categorias: JSON.parse(fromBase64Utf8(file.contentBase64)), sha: file.sha };
}

async function guardarCategorias(env, categorias, sha, mensaje) {
  return putFile(env, "categorias.json", toBase64Utf8(JSON.stringify(categorias, null, 2)), mensaje, sha);
}

async function handleCategoriaAgregar(request, env) {
  const { password, nombre, genero, talles } = await request.json();
  if (!checkPassword(env, password)) return jsonResponse({ error: "Clave incorrecta" }, 401);
  const limpio = String(nombre || "").trim();
  const id = limpiarTexto(limpio);
  if (!id) return jsonResponse({ error: "Escribí un nombre para la categoría" }, 400);

  for (let intento = 0; intento < 2; intento++) {
    const { categorias, sha } = await leerCategorias(env);
    if (categorias.some((c) => c.id === id)) return jsonResponse({ error: "Ya existe una categoría con ese nombre" }, 409);
    const nuevas = [...categorias, { id, nombre: limpio, genero: !!genero, talles: !!talles }];
    try {
      await guardarCategorias(env, nuevas, sha, `Nueva categoría: ${limpio}`);
      return jsonResponse({ ok: true, categorias: nuevas });
    } catch (e) {
      if (intento === 1) return jsonResponse({ error: "No se pudo guardar la categoría: " + e.message }, 500);
    }
  }
}

async function handleCategoriaEliminar(request, env) {
  const { password, id } = await request.json();
  if (!checkPassword(env, password)) return jsonResponse({ error: "Clave incorrecta" }, 401);

  const { productos } = await leerProductos(env);
  if (productos.some((p) => (p.rubro || "pijamas") === id)) {
    return jsonResponse({ error: "La categoría tiene productos. Movelos o eliminalos primero." }, 400);
  }

  for (let intento = 0; intento < 2; intento++) {
    const { categorias, sha } = await leerCategorias(env);
    const nuevas = categorias.filter((c) => c.id !== id);
    if (nuevas.length === categorias.length) return jsonResponse({ error: "No se encontró esa categoría" }, 404);
    try {
      await guardarCategorias(env, nuevas, sha, `Categoría eliminada: ${id}`);
      return jsonResponse({ ok: true, categorias: nuevas });
    } catch (e) {
      if (intento === 1) return jsonResponse({ error: "No se pudo eliminar la categoría: " + e.message }, 500);
    }
  }
}

async function handleAgregar(request, env) {
  const body = await request.json();
  const { password, nombre, precio, descripcion, categoria, rubro, talles, fotos, portada } = body;

  if (!checkPassword(env, password)) return jsonResponse({ error: "Clave incorrecta" }, 401);
  if (!nombre || !precio || !Array.isArray(fotos) || fotos.length === 0) {
    return jsonResponse({ error: "Faltan datos (nombre, precio o al menos una foto)" }, 400);
  }

  const rubroId = String(rubro || "pijamas");
  const { categorias } = await leerCategorias(env);
  const rb = categorias.find((c) => c.id === rubroId);
  if (!rb) return jsonResponse({ error: "La categoría no existe" }, 400);

  // 1) Subir todas las fotos (archivos nuevos siempre => nunca hay conflicto)
  const nombresFotos = await subirFotos(env, nombre, fotos);
  if (nombresFotos.length === 0) return jsonResponse({ error: "No se pudo subir ninguna foto" }, 500);

  const idxPortada = Number.isInteger(portada) && portada >= 0 && portada < nombresFotos.length ? portada : 0;
  const imagenPortada = nombresFotos[idxPortada];
  const galeria = nombresFotos.filter((_, i) => i !== idxPortada);

  // 2) Agregar la entrada al products.json (con un reintento si alguien más escribió justo antes)
  for (let intento = 0; intento < 2; intento++) {
    const { productos, sha } = await leerProductos(env);
    productos.push({
      imagen: imagenPortada,
      galeria,
      rubro: rubroId,
      nombre: String(nombre).trim(),
      precio: isNaN(Number(precio)) ? String(precio) : Number(precio),
      descripcion: String(descripcion || "").trim(),
      categoria: rb.genero ? String(categoria || "").trim().toLowerCase() : "",
      talles: rb.talles ? limpiarTalles(talles) : [],
    });
    try {
      await guardarProductos(env, productos, sha, `Agregado producto: ${nombre}`);
      return jsonResponse({ ok: true, imagen: imagenPortada, galeria });
    } catch (e) {
      if (intento === 1) return jsonResponse({ error: "No se pudo guardar el producto: " + e.message }, 500);
      // si falló por sha desactualizado, reintenta leyendo de nuevo
    }
  }
}

async function handleEditar(request, env) {
  const body = await request.json();
  const { password, imagen, nombre, precio, descripcion, categoria, rubro, talles, fotosNuevas, eliminarFotos, portada } = body;

  if (!checkPassword(env, password)) return jsonResponse({ error: "Clave incorrecta" }, 401);
  if (!imagen) return jsonResponse({ error: "Falta indicar qué producto editar" }, 400);

  for (let intento = 0; intento < 2; intento++) {
    const { productos, sha } = await leerProductos(env);
    const idx = productos.findIndex((p) => p.imagen === imagen || (p.galeria || []).includes(imagen));
    if (idx === -1) return jsonResponse({ error: "No se encontró ese producto" }, 404);

    const actual = productos[idx];
    let fotosActuales = [actual.imagen, ...(actual.galeria || [])].filter(Boolean);

    // sacar las fotos marcadas para eliminar (y borrar el archivo real de GitHub)
    if (Array.isArray(eliminarFotos) && eliminarFotos.length) {
      for (const f of eliminarFotos) {
        if (fotosActuales.includes(f)) {
          fotosActuales = fotosActuales.filter((x) => x !== f);
          await borrarFoto(env, f);
        }
      }
    }

    // subir las fotos nuevas y sumarlas
    if (Array.isArray(fotosNuevas) && fotosNuevas.length) {
      const nuevos = await subirFotos(env, nombre || actual.nombre, fotosNuevas);
      fotosActuales = [...fotosActuales, ...nuevos];
    }

    if (fotosActuales.length === 0) {
      return jsonResponse({ error: "El producto necesita al menos una foto" }, 400);
    }

    // definir portada: la pedida si sigue existiendo, si no la que ya tenía, si no la primera disponible
    let nuevaPortada = actual.imagen;
    if (portada && fotosActuales.includes(portada)) nuevaPortada = portada;
    if (!fotosActuales.includes(nuevaPortada)) nuevaPortada = fotosActuales[0];

    const nuevaGaleria = fotosActuales.filter((f) => f !== nuevaPortada);

    productos[idx] = {
      ...actual,
      imagen: nuevaPortada,
      galeria: nuevaGaleria,
      rubro: rubro !== undefined ? String(rubro) : (actual.rubro || "pijamas"),
      nombre: nombre !== undefined ? String(nombre).trim() : actual.nombre,
      precio: precio !== undefined ? (isNaN(Number(precio)) ? String(precio) : Number(precio)) : actual.precio,
      descripcion: descripcion !== undefined ? String(descripcion).trim() : actual.descripcion,
      categoria: categoria !== undefined ? String(categoria).trim().toLowerCase() : actual.categoria,
      talles: talles !== undefined ? limpiarTalles(talles) : (actual.talles || []),
    };

    try {
      await guardarProductos(env, productos, sha, `Editado producto: ${productos[idx].nombre}`);
      return jsonResponse({ ok: true, imagen: nuevaPortada, galeria: nuevaGaleria });
    } catch (e) {
      if (intento === 1) return jsonResponse({ error: "No se pudo guardar los cambios: " + e.message }, 500);
      // si falló por sha desactualizado, reintenta leyendo de nuevo
    }
  }
}

async function handleVerificar(request, env) {
  const body = await request.json();
  const { password } = body;
  if (!checkPassword(env, password)) return jsonResponse({ error: "Clave incorrecta" }, 401);
  return jsonResponse({ ok: true });
}

async function handleEliminar(request, env) {
  const body = await request.json();
  const { password, imagen } = body;

  if (!checkPassword(env, password)) return jsonResponse({ error: "Clave incorrecta" }, 401);
  if (!imagen) return jsonResponse({ error: "Falta indicar qué producto eliminar" }, 400);

  for (let intento = 0; intento < 2; intento++) {
    const { productos, sha } = await leerProductos(env);
    const producto = productos.find((p) => p.imagen === imagen);
    const nuevaLista = productos.filter((p) => p.imagen !== imagen);
    if (!producto) {
      return jsonResponse({ error: "No se encontró ese producto" }, 404);
    }
    try {
      await guardarProductos(env, nuevaLista, sha, `Eliminado producto (${imagen})`);
      // borramos también todas sus fotos (portada + galería) para no acumular archivos sueltos
      const todasLasFotos = [producto.imagen, ...(producto.galeria || [])].filter(Boolean);
      for (const f of todasLasFotos) {
        await borrarFoto(env, f);
      }
      return jsonResponse({ ok: true });
    } catch (e) {
      if (intento === 1) return jsonResponse({ error: "No se pudo eliminar: " + e.message }, 500);
    }
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/verificar") {
        return await handleVerificar(request, env);
      }
      if (request.method === "POST" && url.pathname === "/categorias-agregar") {
        return await handleCategoriaAgregar(request, env);
      }
      if (request.method === "POST" && url.pathname === "/categorias-eliminar") {
        return await handleCategoriaEliminar(request, env);
      }
      if (request.method === "POST" && url.pathname === "/agregar") {
        return await handleAgregar(request, env);
      }
      if (request.method === "POST" && url.pathname === "/editar") {
        return await handleEditar(request, env);
      }
      if (request.method === "POST" && url.pathname === "/eliminar") {
        return await handleEliminar(request, env);
      }
      return jsonResponse({ error: "Ruta no encontrada" }, 404);
    } catch (e) {
      return jsonResponse({ error: "Error inesperado: " + e.message }, 500);
    }
  },
};
