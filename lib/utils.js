const utils = {
    isPlainObject (o, strict = true) {
        if (o === null || o === undefined) {
            return false
        }

        const isInstanceOfObject = o instanceof Object
        const isTypeOfObject = typeof o === 'object'
        const isConstructorUndefined = o.constructor === undefined
        const isConstructorObject = o.constructor === Object
        const isTypeOfConstructorObject = typeof o.constructor === 'function'

        let r
        if (strict === true) {
            r = (isInstanceOfObject || isTypeOfObject) && (isConstructorUndefined || isConstructorObject)
        } else {
            r = (isConstructorUndefined || isTypeOfConstructorObject)
        }
        return r
    },
    merge (target, source) {
        const self = this
        const isObject = obj => obj && typeof obj === 'object'

        if (!isObject(target) || !isObject(source)) {
            return source
        }

        Object.keys(source).forEach(key => {
            const targetValue = target[key]
            const sourceValue = source[key]

            if (Array.isArray(targetValue) && Array.isArray(sourceValue)) {
                target[key] = targetValue.concat(sourceValue)
            } else if (isObject(targetValue) && isObject(sourceValue)) {
                target[key] = utils.merge(Object.assign({}, targetValue), sourceValue)
            } else {
                target[key] = sourceValue
            }
        })

        return target
    }
}
module.exports = utils