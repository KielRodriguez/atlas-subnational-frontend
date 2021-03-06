import Ember from 'ember';
import ENV from '../../config/environment';

const {apiURL} = ENV;
const {RSVP, computed, getWithDefault, get} = Ember;

export default Ember.Route.extend({
// `this.store.find` makes an api call for `params.location_id` and returns a promise
// in the `then` function call, another API call is made to get the topExports data
  i18n: Ember.inject.service(),
  featureToggle: Ember.inject.service(),

  firstYear: computed.alias('featureToggle.first_year'),
  lastYear: computed.alias('featureToggle.last_year'),
  censusYear: computed.alias('featureToggle.census_year'),

  model: function(params) {
    return this.store.find('location', params.location_id);
  },
  afterModel: function(model) {
    let level = model.get('level');
    level = level === 'country' ? 'department' : level;

    let subregion = get(this, `featureToggle.subregions.${model.get('level')}`);

    // TODO: maybe use ember data instead of ajax calls to decorate JSON objects with model functionality?
    // extract year out later
    var products = Ember.$.getJSON(`${apiURL}/data/location/${model.id}/products?level=4digit`);
    var industries = Ember.$.getJSON(`${apiURL}/data/location/${model.id}/industries?level=class`);

    // one of these should be removed in the future because the points should be merged in
    var dotplot = Ember.$.getJSON(`${apiURL}/data/location?level=${level}`); //dotplots

    var subregions_trade = Ember.$.getJSON(`${apiURL}/data/location/${model.id}/subregions_trade/?level=${subregion}`);

    var occupations = Ember.$.getJSON(`${apiURL}/data/occupation/?level=minor_group`);

    return RSVP.allSettled([products, dotplot, industries, subregions_trade, occupations]).then((array) => {
      var productsData = getWithDefault(array[0], 'value.data', []);

      var dotplotData = getWithDefault(array[1], 'value.data', []);//dotplots

      var industriesData = getWithDefault(array[2], 'value.data', []);

      var subregionsTradeData = _.filter(getWithDefault(array[3], 'value.data', []), { 'year': this.get('lastYear')});

      var occupationsData = getWithDefault(array[4], 'value.data', []);

      var productsDataIndex = _.indexBy(productsData, 'product_id');
      var industriesDataIndex = _.indexBy(industriesData, 'industry_data');

      let productsMetadata = this.modelFor('application').products;
      let locationsMetadata = this.modelFor('application').locations;
      let industriesMetadata = this.modelFor('application').industries;
      let occupationsMetadata = this.modelFor('application').occupations;

      //get products data for the department
      let products = _.reduce(productsData, (memo, d) => {
        if(d.year != this.get('lastYear')) { return memo; }
        let product = productsMetadata[d.product_id];
        let productData = productsDataIndex[d.product_id];
        product.complexity = _.result(_.find(product.pci_data, { year: d.year }), 'pci');
        memo.push(_.merge(d, product, productData));
        return memo;
      }, []);

      //get industry data for department
      let industries = _.reduce(industriesData, (memo, d) => {
        if(d.year != this.get('lastYear')) { return memo; }
        let industry = industriesMetadata[d.industry_id];
        if(model.id === '0') { d.rca = 1; }
        let industryData = industriesDataIndex[d.industry_id];
        industry.complexity = _.result(_.find(industry.pci_data, { year: d.year}), 'complexity');
        memo.push(_.merge(d, industry, industryData));
        return memo;
      }, []);

      let occupationVacanciesSum = 0;
      let occupations = _.map(occupationsData, (d) => {
        occupationVacanciesSum += d.num_vacancies;
        let occupation = occupationsMetadata[d.occupation_id];
        return _.merge(d, occupation);
      });

      occupations.forEach((d) => {
        d.share = d.num_vacancies/occupationVacanciesSum;
      });

      //dotplots and dotplotTimeSeries power the dotplots, rankings and etc
      var dotplot = [];
      var dotplotTimeSeries= [];

      _.each(dotplotData, (d) => {
        let id = _.get(d, 'department_id') || _.get(d, 'location_id');
        if(id == model.id) {
          dotplotTimeSeries.push(d);
        }
        if(d.year === this.get('censusYear')) {
          let id = _.get(d, 'department_id') || _.get(d, 'location_id');

          let location = _.get(locationsMetadata, id);

          let extra = {
            name: location.name_en,
            group: d.code,
            parent_name_en: location.name_en,
            parent_name_es: location.name_es,
          };

          let datum = _.merge(d, location, extra );
          dotplot.push(datum);
        }
      });

      let subregions = [];
      _.each(subregionsTradeData, (d) => {
        let id = _.get(d, 'department_id') || _.get(d, 'location_id');

        let location = _.get(locationsMetadata, id);
        let extra = {
          name: location.name_en,
          group: d.code,
          parent_name_en: location.name_en,
          parent_name_es: location.name_es,
        };

        let datum = _.merge(d, location, extra );
        subregions.push(datum);
      });

      var eciRank = 1;
      var populationRank = 1;
      var gdpRank = 1;
      var gdpPerCapitaRank = 1;

      let datum = _.chain(dotplotTimeSeries)
        .select({ year: this.get('censusYear')})
        .first()
        .value();

      if(datum) {
        _.each(dotplot, (d) => {
          if(d.eci != null && d.eci > datum.eci) { eciRank ++; }
          if(d.gdp_real != null && d.gdp_real > datum.gdp_real) { gdpRank ++; }
          if(d.population != null && d.population > datum.population ) { populationRank ++; }
          if(d.gdp_pc_real != null && d.gdp_pc_real> datum.gdp_pc_real ) { gdpPerCapitaRank++; }
        });
      }

      if(datum !== undefined && (datum.eci === undefined || datum.eci === null)){
         eciRank = null;
      }

      model.setProperties({
        eciRank: eciRank,
        gdpRank: gdpRank,
        gdpPerCapitaRank: gdpPerCapitaRank,
        populationRank: populationRank
      });

      model.set('productsData', products);
      model.set('industriesData', industries);
      model.set('dotplotData', dotplot);
      model.set('occupations', occupations);
      model.set('timeseries', dotplotTimeSeries);
      model.set('metaData', this.modelFor('application'));
      model.set('subregions', subregions);

      return model;
    });
  },
  setupController(controller, model) {
    this._super(controller, model);
    this.controllerFor('application').set('entity', model.get('constructor.modelName'));
    this.controllerFor('application').set('entity_id', model.get('id'));
    window.scrollTo(0, 0);
  },
});
