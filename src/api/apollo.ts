import { ApolloClient, ApolloLink, InMemoryCache, Observable, gql } from '@apollo/client/core'
import { seedDevices, seedRules } from '../stores/seed'

export const LINKAGE_QUERY = gql`
  query LinkageConfiguration {
    project { id name building standard }
    devices { id name type floor zone address }
    rules { id triggerId actionId delay interlock priority suppression enabled }
  }
`

export const UPDATE_RULE_MUTATION = gql`
  mutation UpdateRule($rule: RuleInput!) {
    updateRule(rule: $rule) { id enabled priority delay interlock suppression }
  }
`

function executeGraphQL(operationName: string, variables: Record<string, unknown>) {
  const project = { id: 'FAS-2026-09', name: '滨江研发中心消防联动配置', building: '1 号楼 / 2 号楼', standard: 'GB 50116-2013' }
  if (operationName === 'LinkageConfiguration') {
    return { project, devices: seedDevices, rules: seedRules.map((rule) => ({ __typename: 'Rule', ...rule })) }
  }
  if (operationName === 'UpdateRule') {
    const rule = variables.rule as Record<string, unknown>
    return { updateRule: { __typename: 'Rule', ...rule } }
  }
  return {}
}

export const mockGraphQLTransport = new ApolloLink(
  (operation) =>
    new Observable((observer) => {
      const timer = window.setTimeout(() => {
        observer.next({ data: executeGraphQL(operation.operationName, operation.variables) })
        observer.complete()
      }, 180)
      return () => window.clearTimeout(timer)
    }),
)

export const apolloClient = new ApolloClient({
  link: mockGraphQLTransport,
  cache: new InMemoryCache(),
  defaultOptions: { watchQuery: { fetchPolicy: 'cache-first' } },
})
