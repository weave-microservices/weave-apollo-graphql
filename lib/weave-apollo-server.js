const { ApolloServerBase } = require('apollo-server-core')
const { processRequest } = require('graphql-upload')
const { renderPlaygroundPage } = require('@apollographql/graphql-playground-html')
const createGraphqlHandler = require('./graphql-handler')

const send = (request, response, statusCode, data, responseType) => {
    // context, route, request, response, action, data
    const context = request.$context
    const service = request.$service

    if (responseType) {
        context.meta.$responseType = responseType
    }
    response.statusCode = 200
    return service.sendResponse(context, null, request, response, null, data)
}

class WeaveApolloServer extends ApolloServerBase {
    createGraphQLServerOptions (request, response) {
        return super.graphQLServerOptions({ request, response })
    }

    createHandler ({ path, disableHealthCheck, onHealthCheck } = {}) {
        const promise = this.willStart()
        return async (request, response) => {
            await promise
            this.graphqlPath = path || '/graphql'

            if (this.uploadsConfig) {
                const contentType = request.headers['content-type']
                if (contentType && contentType === 'multipart/form-data') {
                    this.filePayload = await processRequest(request, response, this.uploadsConfig)
                }
            }

            if (this.playgroundOptions && request.method === 'GET') {
                const middlewareOptions = Object.assign({
                    endpoint: this.graphqlPath,
                    subscriptionEndpoint: this.subscriptionsPath
                }, this.playgroundOptions)
                return send(request, response, 200, renderPlaygroundPage(middlewareOptions), 'text/html')
            }

            const graphqlHandler = createGraphqlHandler(() => this.createGraphQLServerOptions(request, response))
            const result = await graphqlHandler(request, response)
            return send(request, response, 200, result, 'application/json; charset=utf-8;')
        }
    }

    supportsUploads() {
        return true;
	}
    
    // // enable subscription support
	supportsSubscriptions() {
		return true;
	}
}

module.exports = WeaveApolloServer
