import { sparqlEscapeUri } from 'mu';
import { querySudo as query } from '@lblod/mu-auth-sudo';
import {
    ACCOUNT_GRAPH_TEMPLATE,
    SESSION_GRAPH,
    ORGANIZATION_TYPE
} from './config';

const getSessionIdHeader = function(request) {
    return request.get('mu-session-id');
};

function accountGraphFor(params) {
    return ACCOUNT_GRAPH_TEMPLATE.replace('{{groupId}}', params.groupId);
}

async function getGroupIdForSession(session) {
    const queryResult = await query(`
      PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
      PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
      SELECT DISTINCT ?groupId WHERE {
         GRAPH ${sparqlEscapeUri(SESSION_GRAPH)} {
            ${sparqlEscapeUri(session)} ext:sessionGroup ?group .
        }
        GRAPH <${process.env.MU_APPLICATION_GRAPH}> {
        ?group a ${sparqlEscapeUri(ORGANIZATION_TYPE)} ;
               mu:uuid ?groupId .
        }
      }
    `);
    if (queryResult.results.bindings.length) {
      const result = queryResult.results.bindings[0];
      return result.groupId.value;
    }
    else
      return null;
}

async function selectAccountBySession(session) {
    const groupId = await getGroupIdForSession(session);
    const queryResult = await query(`
      PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
      PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
      PREFIX session: <http://mu.semte.ch/vocabularies/session/>
      PREFIX foaf: <http://xmlns.com/foaf/0.1/>
      PREFIX besluit: <http://data.vlaanderen.be/ns/besluit#>
  
      SELECT ?account ?accountId
      WHERE {
         GRAPH ${sparqlEscapeUri(SESSION_GRAPH)} {
            ${sparqlEscapeUri(session)} session:account ?account.
        }
        GRAPH ${sparqlEscapeUri(accountGraphFor({ groupId }))} {
            ?account a foaf:OnlineAccount ;
                     mu:uuid ?accountId .
        }
      }`);
  
    if (queryResult.results.bindings.length) {
      const result = queryResult.results.bindings[0];
      return { accountUri: result.account.value, accountId: result.accountId.value };
    } else {
      return { accountUri: null, accountId: null };
    }
}

export { getSessionIdHeader, selectAccountBySession };