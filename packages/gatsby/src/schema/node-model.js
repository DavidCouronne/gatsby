// @flow

const _ = require(`lodash`)
const {
  isAbstractType,
  GraphQLOutputType,
  GraphQLUnionType,
} = require(`graphql`)
const invariant = require(`invariant`)

type IDOrNode = string | { id: string }
type TypeOrTypeName = string | GraphQLOutputType

/**
 * Optional page dependency information.
 *
 * @typedef {Object} PageDependencies
 * @property {string} path The path of the page that depends on the retrieved nodes' data
 * @property {string} [connectionType] Mark this dependency as a connection
 */
interface PageDependencies {
  path: string;
  connectionType?: string;
}

interface QueryArguments {
  type: TypeOrTypeName;
  query: { filter: Object, sort?: Object };
  firstOnly?: boolean;
}

export interface NodeModel {
  getNodeById(
    { id: IDOrNode, type?: TypeOrTypeName },
    pageDependencies?: PageDependencies
  ): any | null;
  getNodesByIds(
    { ids: Array<IDOrNode>, type?: TypeOrTypeName },
    pageDependencies?: PageDependencies
  ): Array<any>;
  getAllNodes(
    { type?: TypeOrTypeName },
    pageDependencies?: PageDependencies
  ): Array<any>;
  runQuery(
    args: QueryArguments,
    pageDependencies?: PageDependencies
  ): Promise<any>;
  getTypes(): Array<string>;
  trackPageDependencies<nodeOrNodes: Node | Node[]>(
    result: nodeOrNodes,
    pageDependencies?: PageDependencies
  ): nodesOrNodes;
}

class LocalNodeModel {
  constructor({ schema, nodeStore, createPageDependency, path }) {
    this.schema = schema
    this.nodeStore = nodeStore
    this.createPageDependency = createPageDependency
    this.path = path
  }

  /**
   * Get a node from the store by ID and optional type.
   *
   * @param {Object} args
   * @param {string} args.id ID of the requested node
   * @param {(string|GraphQLOutputType)} [args.type] Optional type of the node
   * @param {PageDependencies} [pageDependencies]
   * @returns {(Node|null)}
   */
  getNodeById(args, pageDependencies) {
    const { id, type } = args || {}

    const node = getNodeById(this.nodeStore, id)

    let result
    if (!node) {
      result = null
    } else if (!type) {
      result = node
    } else {
      const nodeTypeNames = toNodeTypeNames(this.schema, type)
      result = nodeTypeNames.includes(node.internal.type) ? node : null
    }

    return this.trackPageDependencies(result, pageDependencies)
  }

  /**
   * Get nodes from the store by IDs and optional type.
   *
   * @param {Object} args
   * @param {string[]} args.ids IDs of the requested nodes
   * @param {(string|GraphQLOutputType)} [args.type] Optional type of the nodes
   * @param {PageDependencies} [pageDependencies]
   * @returns {Node[]}
   */
  getNodesByIds(args, pageDependencies) {
    const { ids, type } = args || {}

    const nodes = Array.isArray(ids)
      ? ids.map(id => getNodeById(this.nodeStore, id)).filter(Boolean)
      : []

    let result
    if (!nodes.length || !type) {
      result = nodes
    } else {
      const nodeTypeNames = toNodeTypeNames(this.schema, type)
      result = nodes.filter(node => nodeTypeNames.includes(node.internal.type))
    }

    return this.trackPageDependencies(result, pageDependencies)
  }

  /**
   * Get all nodes in the store, or all nodes of a specified type. Note that
   * this doesn't add tracking to all the nodes, unless pageDependencies are
   * passed.
   *
   * @param {Object} args
   * @param {(string|GraphQLOutputType)} [args.type] Optional type of the nodes
   * @param {PageDependencies} [pageDependencies]
   * @returns {Node[]}
   */
  getAllNodes(args, pageDependencies) {
    const { type } = args || {}

    let result
    if (!type) {
      result = this.nodeStore.getNodes()
    } else {
      const nodeTypeNames = toNodeTypeNames(this.schema, type)
      const nodes = nodeTypeNames.reduce(
        (acc, typeName) => acc.concat(this.nodeStore.getNodesByType(typeName)),
        []
      )
      result = nodes.filter(Boolean)
    }

    if (pageDependencies) {
      return this.trackPageDependencies(result, pageDependencies)
    } else {
      return result
    }
  }

  /**
   * Get nodes of a type matching the specified query.
   *
   * @param {Object} args
   * @param {Object} args.query Query arguments (`filter` and `sort`)
   * @param {(string|GraphQLOutputType)} args.type Type
   * @param {boolean} [args.firstOnly] If true, return only first match
   * @param {PageDependencies} [pageDependencies]
   * @returns {Promise<Node[]>}
   */
  async runQuery(args, pageDependencies) {
    const { query, firstOnly, type } = args || {}

    // We don't support querying union types (yet?), because the combined types
    // need not have any fields in common.
    const gqlType = typeof type === `string` ? this.schema.getType(type) : type
    invariant(
      !(gqlType instanceof GraphQLUnionType),
      `Querying GraphQLUnion types is not supported.`
    )

    // We provide nodes in case of abstract types, because `run-sift` should
    // only need to know about node types in the store.
    let nodes
    if (isAbstractType(gqlType)) {
      const nodeTypeNames = toNodeTypeNames(this.schema, gqlType)
      nodes = nodeTypeNames.reduce(
        (acc, typeName) => acc.concat(this.nodeStore.getNodesByType(typeName)),
        []
      )
    }

    const queryResult = await this.nodeStore.runQuery({
      queryArgs: query,
      firstOnly,
      gqlType,
      nodes,
    })

    let result = queryResult
    if (args.firstOnly) {
      if (result && result.length > 0) {
        result = result[0]
      } else {
        result = null
      }
    }

    return this.trackPageDependencies(result, pageDependencies)
  }

  /**
   * Get the names of all node types in the store.
   *
   * @returns {string[]}
   */
  getTypes() {
    return this.nodeStore.getTypes()
  }

  /**
   * Get the root ancestor node for an object's parent node, or its first
   * ancestor matching a specified condition.
   *
   * @param {(Object|Array)} obj An object belonging to a Node, or a Node object
   * @param {Function} [predicate] Optional condition to match
   * @returns {(Node|null)}
   */
  findRootNodeAncestor(obj, predicate) {
    return this.nodeStore.findRootNodeAncestor(obj, predicate)
  }

  /**
   * Given a result, that's either a single node or an array of them, track them
   * using pageDependencies. Defaults to tracking according to current resolver
   * path. Returns the result back.
   *
   * @param {Node | Node[]} result
   * @param {PageDependencies} [pageDependencies]
   * @returns {Node | Node[]}
   */
  trackPageDependencies(result, pageDependencies) {
    const fullDependencies = {
      path: this.path,
      ...(pageDependencies || {}),
    }
    const { path, connectionType } = fullDependencies
    if (path) {
      if (connectionType) {
        this.createPageDependency({ path, connection: connectionType })
      } else {
        const nodes = Array.isArray(result) ? result : [result]
        nodes
          .filter(Boolean)
          .map(node => this.createPageDependency({ path, nodeId: node.id }))
      }
    }

    return result
  }
}

const getNodeById = (nodeStore, id) => {
  // This is for cases when the `id` has already been resolved
  // to a full Node for the input filter, and is also in the selection
  // set. E.g. `{ foo(parent: { id: { eq: 1 } } ) { parent { id } } }`.
  if (_.isPlainObject(id) && id.id) {
    return id
  }
  return id != null ? nodeStore.getNode(id) : null
}

const toNodeTypeNames = (schema, gqlTypeName) => {
  const gqlType =
    typeof gqlTypeName === `string` ? schema.getType(gqlTypeName) : gqlTypeName

  if (!gqlType) return []

  const possibleTypes = isAbstractType(gqlType)
    ? schema.getPossibleTypes(gqlType)
    : [gqlType]

  return possibleTypes
    .filter(type => type.getInterfaces().some(iface => iface.name === `Node`))
    .map(type => type.name)
}

module.exports = {
  LocalNodeModel,
}
