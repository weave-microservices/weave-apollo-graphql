const fs = require('fs')
const { join } = require('path')

const { printSchema } = require('graphql')
const { makeExecutableSchema } = require('graphql-tools')
const { PubSub, withFilter } = require('graphql-subscriptions')

const { isPlainObject, merge } = require('./utils')
const WeaveApolloServer = require('./weave-apollo-server')

const wrapArray = (obj) => Array.isArray(obj) ? obj : [obj]

module.exports = (mixinOptions) => {
    mixinOptions = Object.assign({
        routeOptions: {
            path: '/graphql'
        },
        generateSnapshot: true,
        snapshotPath: `${process.cwd()}/schema.snapshot.graphql`,
        customTypes: {},
        resolvers: {},
        typeDefs: [],
        serverOptions: {
            playground: false
        }
    }, mixinOptions)

    let isSchemaValid = false

    const mixinSchema = {
        name: 'graphql',
        settings: {
            transport: null,
            from: null
        },
        events: {
            '$services.changed' () {
                this.invalidateGraphQLSchema()
            },
            'graphql.publish' (event) {
                this.pubSub.publish(event.tag, event.payload)
            }
        },
        methods: {
            prepareGraphQLSchema () {
                if (isSchemaValid && this.graphqlHandler) {
                    return
                }

                this.log.info(`Created Graphql schema.`)
                
                try {
                    // create a new pub/sub channel.
                    this.pubSub = new PubSub()
                    const services = this.broker.registry.services.list({ withActions: true, withSettings: true })
                    this.schema = this.generateGraphQLSchema(services)
    
                    if (mixinOptions.generateSnapshot) {
                        this.createSnapshot()
                    }
    
                    this.apolloServer = new WeaveApolloServer(Object.assign(mixinOptions.serverOptions, {
                        schema: this.schema,
                        context: ({ request, connection}) => {
                            return request ? {
                                context: request.$context,
                                service: request.$service,
                                params: request.$params
                            } : {
                                service: connection.context.$service
                            }
                        },
                        subscriptions: {
                            onConnect: (connectionParams, webSocket, context) => {
                                return {
                                    ...connectionParams,
                                    $service: this,
                                }
                            },
                        },
                    }))
    
                    this.graphqlHandler = this.apolloServer.createHandler(mixinOptions.serverOptions)
                    this.apolloServer.installSubscriptionHandlers(this.server)
                    isSchemaValid = true

                    this.broker.broadcast('graphql.schema.updated', {
                        schema: printSchema(this.schema)
                    })
                } catch (error) {
                    this.log.error(error)
                    throw error
                }
            },
            invalidateGraphQLSchema () {
                isSchemaValid = false
            },
            generateGraphQLSchema (services) {
                try {
                    const typeDefs = [].concat(mixinOptions.typeDefs)
                    const queries = []
                    const schemaDirectives = null
                    const mutations = []
                    const subscriptions = []
                    const enums = []
            
                    let resolvers = Object.assign({}, mixinOptions.resolvers)
                    let types = []

                    services.map(service => {
                        if (service.settings.graphql) {
                            const globalGraphqlDefs = service.settings.graphql

                            if (globalGraphqlDefs.type) {
                                types = types.concat(globalGraphqlDefs.type)
                            }

                            if (globalGraphqlDefs.resolvers) {
                                resolvers = Object.entries(globalGraphqlDefs.resolvers)
                                    .reduce((a, [name, res]) => {
                                        a[name] = merge(
                                            a[name] || {},
                                            this.createServiceResolver(service.name, res)
                                        )
                                        return a
                                    }, resolvers)// types.concat(globalGraphqlDefs.type)
                            }

                            if (globalGraphqlDefs.subscription) {
                                subscriptions = subscriptions.concat(globalGraphqlDefs.subscription)
                            }
                        }

                        const resolver = {}
                        Object.values(service.actions).map(action => {
                            const { graphql: definitions } = action

                            if (definitions) {
                                if (definitions.query) {
                                    if (!resolver['Query']) {
                                        resolver['Query'] = {}
                                    }
                                    wrapArray(definitions.query).map(query => {
                                        const name = query.trim().split(/[(:]/g)[0].trim()
                                        queries.push(query)
                                        resolver.Query[name] = this.createActionResolver(action.name)
                                    })
                                }

                                if (definitions.mutation) {
                                    if (!resolver['Mutation']) {
                                        resolver['Mutation'] = {}
                                    }
                                    wrapArray(definitions.mutation).map(mutation => {
                                        const name = mutation.trim().split(/[(:]/g)[0].trim()
                                        mutations.push(mutation)
                                        resolver.Mutation[name] = this.createActionResolver(action.name)
                                    })
                                }

                                if (definitions.subscription) {
                                    if (!resolver['Subscription']) {
                                        resolver['Subscription'] = {}
                                    }

                                    wrapArray(definitions.subscription).map(subscription => {
                                        subscriptions.push(subscription)
                                        const name = this.getFieldName(subscription)
                                        resolver.Subscription[name] = this.createAsyncIterationResolver(action.name, definitions.tags, definitions.filter)
                                    })
                                }
                            }
                        })

                        if (Object.keys(resolver).length > 0) {
                            resolvers = merge(resolvers, resolver)
                        }
                    })

                    if (queries.length > 0
                        || types.length > 0
                        || mutations.length > 0
                        || enums.length > 0
                        || subscriptions.length > 0) {
                        let queryString = ''

                        if (queries.length > 0) {
                            queryString += `
                                type Query {
                                    ${queries.join('\n')}
                                }
                            `
                        }

                        if (mutations.length > 0) {
                            queryString += `
                                type Mutation {
                                    ${mutations.join('\n')}
                                }
                            `
                        }

                        if (types.length > 0) {
                            queryString += `
                                ${types.join('\n')}
                            `
                        }

                        if (enums.length > 0) {
                            queryString += `
                                ${enums.join('\n')}
                            `
                        }

                        if (subscriptions.length > 0) {
                            queryString += `
                                type Subscription {
                                    ${subscriptions.join('\n')}
                                }
                            `
                        }

                        typeDefs.push(queryString)
                    }

                    return makeExecutableSchema({ typeDefs, resolvers, schemaDirectives })
                } catch (error) {
                    this.log.error(error)
                }
            },
            getFieldName (definition) {
                return definition.trim()
                    .split(/[(:]/g)[0]
                    .trim()
            },
            createServiceResolver (serviceName, resolvers) {
                return Object.entries(resolvers).reduce((a, [p, resolver]) => {
                    if (isPlainObject(resolver) && resolver.action) {
                        a[p] = this.createActionResolver(resolver.action, resolver)
                    }
                    return a
                //    a[]
                //     return a
                }, {})
            },
            createActionResolver (actionName, p) {
                return async (root, params, context) => {
                    try {
                        if (p && p.rootParams) {
                            params = Object.entries(p.rootParams).reduce((params, [rootParam, targetParam]) => {
                                const rootVal = root[rootParam]
                                params[targetParam] = rootVal
                                return params
                            }, params || {})
                        }
                        return context.context.call(actionName, params)
                    } catch (error) {
                        return error
                    }
                }
            },
            createAsyncIterationResolver (action, tags = [], filter = false) {
                return {
                    subscribe: () => this.pubSub.asyncIterator(tags),
                    resolve: (payload, params, context) => {
                        return this.broker.call(action, { ...params, payload }, context)
                    }
                }
            },
            createSnapshot () {
                if (this.schema) {
                    fs.writeFileSync(mixinOptions.snapshotPath, printSchema(this.schema))
                }
            }
        },
        created () {
            if (!this.sendError) {
                throw new Error('Weave API mixin is missing.')
            }

            const graphqlRoute = Object.assign({
                aliases: {
                    '/' (request, response) {
                        try {
                            this.prepareGraphQLSchema()
                            return this.graphqlHandler(request, response)
                        } catch (error) {
                            this.sendError(request, response, error)
                        }
                    },
                    '/.well-known/apollo/server-health' (request, response) {
                        try {
                            this.prepareGraphQLSchema()
                        } catch (error) {
                            this.sendError(request, response, error)
                        }
                        return this.graphqlHandler(request, response)
                    }
                },
                mappingPolicy: 'restrict',
                bodyParsers: {
                    json: true,
                    urlencoded: { extended: true }
                }
            }, mixinOptions.routeOptions)

            this.settings.routes.unshift(graphqlRoute)
        }
    }

    return mixinSchema
}
