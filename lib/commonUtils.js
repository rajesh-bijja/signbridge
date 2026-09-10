let coreUtils = require('./coreUtils');

function resolveEndpoint(loginUserName, endpoint) {
    if (endpoint == null || endpoint.length == 0 || !endpoint.includes('{{') || !endpoint.includes('}}')) {
        return endpoint;
    }
    let extractedVariables = endpoint.match(/{{(.*?)}}/gm);
    if (extractedVariables == null || extractedVariables.length == 0) {
        return endpoint;
    }
    let settingsMetadataOutputObj = coreUtils.getSettingsMetadataSync(loginUserName);
    let settingsVariables = settingsMetadataOutputObj.variables;
    if (settingsVariables == null || settingsVariables.length == 0) {
        return 'ERROR:: Variables are not configured in settings. Navigate to settings and add the required variables';
    }
    for (let count = 0; count < extractedVariables.length; count++) {
        let eachVar = extractedVariables[count];
        let parsedVar = eachVar.substring(2, eachVar.length -2);
        let variableFound = false;
        for (let j = 0; j < settingsVariables.length; j++) {
            let eachSettingVar = settingsVariables[j];
            if (parsedVar === eachSettingVar['name']) {
                endpoint = endpoint.replace(eachVar, eachSettingVar['value']);
                variableFound = true;
                break;
            }
        }
        if (!variableFound) {
            return 'ERROR:: Variable: ' + parsedVar + ' is not configured in settings. Navigate to settings and add this variable.';
        }
    }
    return endpoint;

}


module.exports = {
    resolveEndpoint: resolveEndpoint
}